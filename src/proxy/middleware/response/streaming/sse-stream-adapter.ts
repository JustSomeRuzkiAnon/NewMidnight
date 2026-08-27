import pino from "pino";
import { Transform, TransformOptions } from "stream";
import { Message } from "@smithy/eventstream-codec";
import { APIFormat } from "../../../../shared/key-management";
import { BadRequestError, RetryableError } from "../../../../shared/errors";
import { parseEvent } from "./parse-sse";

type SSEStreamAdapterOptions = TransformOptions & {
  contentType?: string;
  api: APIFormat;
  logger: pino.Logger;
  /**
   * Treat a rate limit or an unavailable-provider error reported inside the
   * stream as a retryable error rather than forwarding it to the client.
   * Enabled per custom provider.
   */
  retryTransientErrors?: boolean;
};

/**
 * Receives a stream of events in a variety of formats and transforms them into
 * Server-Sent Events.
 *
 * This is an object-mode stream, so it expects to receive objects and will emit
 * strings.
 */
export class SSEStreamAdapter extends Transform {
  private readonly isAwsStream;
  private readonly retryTransientErrors: boolean;
  private api: APIFormat;
  private partialMessage = "";
  private textDecoder = new TextDecoder("utf8");
  private log: pino.Logger;
  /** Whether any part of the completion has already reached the client. */
  private sentCompletionData = false;

  constructor(options: SSEStreamAdapterOptions) {
    super({ ...options, objectMode: true });
    this.isAwsStream =
      options?.contentType === "application/vnd.amazon.eventstream";
    this.retryTransientErrors = options.retryTransientErrors ?? false;
    this.api = options.api;
    this.log = options.logger.child({ module: "sse-stream-adapter" });
  }

  protected processAwsMessage(message: Message): string | null {
    // Per amazon, headers and body are always present. headers is an object,
    // body is a Uint8Array, potentially zero-length.
    const { headers, body } = message;
    const eventType = headers[":event-type"]?.value;
    const messageType = headers[":message-type"]?.value;
    const contentType = headers[":content-type"]?.value;
    const exceptionType = headers[":exception-type"]?.value;
    const errorCode = headers[":error-code"]?.value;
    const bodyStr = this.textDecoder.decode(body);

    switch (messageType) {
      case "event":
        if (contentType === "application/json" && eventType === "chunk") {
          const { bytes } = JSON.parse(bodyStr);
          const event = Buffer.from(bytes, "base64").toString("utf8");
          const eventObj = JSON.parse(event);

          // AWS Bedrock includes usage metrics in the event stream headers
          // Extract and attach them to the event object for downstream processing
          const invocationMetrics = headers["amazon-bedrock-invocationMetrics"];
          if (invocationMetrics?.value) {
            try {
              const metricsStr = typeof invocationMetrics.value === 'string'
                ? invocationMetrics.value
                : JSON.stringify(invocationMetrics.value);
              const metricsObj = JSON.parse(metricsStr);
              eventObj["amazon-bedrock-invocationMetrics"] = metricsObj;
            } catch (e) {
              this.log.warn(
                { invocationMetrics: invocationMetrics.value },
                "Failed to parse AWS invocationMetrics"
              );
            }
          }

          const eventWithMetrics = JSON.stringify(eventObj);

          if ("completion" in eventObj) {
            return ["event: completion", `data: ${eventWithMetrics}`].join(`\n`);
          } else if (eventObj.type) {
            return [`event: ${eventObj.type}`, `data: ${eventWithMetrics}`].join(`\n`);
          } else {
            return `data: ${eventWithMetrics}`;
          }
        }
      // noinspection FallThroughInSwitchStatementJS -- non-JSON data is unexpected
      case "exception":
      case "error":
        const type = String(
          exceptionType || errorCode || "UnknownError"
        ).toLowerCase();
        switch (type) {
          case "throttlingexception":
            this.log.warn(
              "AWS request throttled after streaming has already started; retrying"
            );
            throw new RetryableError("AWS request throttled mid-stream");
          case "validationexception":
            try {
              const { message } = JSON.parse(bodyStr);
              this.log.error({ message }, "Received AWS validation error");
              this.emit(
                "error",
                new BadRequestError(`AWS validation error: ${message}`)
              );
              return null;
            } catch (error) {
              this.log.error(
                { body: bodyStr, error },
                "Could not parse AWS validation error"
              );
            }
          // noinspection FallThroughInSwitchStatementJS -- who knows what this is
          default:
            let text;
            try {
              text = JSON.parse(bodyStr).message;
            } catch (error) {
              text = bodyStr;
            }
            const error: any = new Error(
              `Got mysterious error chunk: [${type}] ${text}`
            );
            error.lastEvent = text;
            this.emit("error", error);
            return null;
        }
      default:
        // Amazon says this can't ever happen...
        this.log.error({ message }, "Received very bad AWS stream event");
        return null;
    }
  }

  _transform(data: any, _enc: string, callback: (err?: Error | null) => void) {
    try {
      if (this.isAwsStream) {
        // `data` is a Message object
        const message = this.processAwsMessage(data);
        if (message) this.push(message + "\n\n");
      } else {
        // `data` is a string, but possibly only a partial message
        const fullMessages = (this.partialMessage + data).split(
          /\r\r|\n\n|\r\n\r\n/
        );
        this.partialMessage = fullMessages.pop() || "";

        for (const message of fullMessages) {
          // Mixing line endings will break some clients and our request queue
          // will have already sent \n for heartbeats, so we need to normalize
          // to \n.
          const normalized = message.replace(/\r\n?/g, "\n");

          // Some upstreams -- particularly other reverse proxies -- answer 200
          // and only then report a rate limit or an unavailable provider inside
          // the stream, so this is the only place we can see it. Retrying is
          // only safe before any of the completion has reached the client;
          // afterwards the retried response would be appended to a partial one.
          if (this.retryTransientErrors && !this.sentCompletionData) {
            if (isRateLimitEvent(normalized)) {
              this.log.warn(
                { event: normalized.slice(0, 256) },
                "Upstream reported a rate limit inside the stream; retrying"
              );
              throw new RetryableError(
                "Upstream rate limit received mid-stream"
              );
            }
            if (isUnavailableEvent(normalized)) {
              this.log.warn(
                { event: normalized.slice(0, 256) },
                "Upstream reported it is unavailable inside the stream; retrying"
              );
              throw new RetryableError(
                "Upstream unavailable error received mid-stream"
              );
            }
          }

          if (getCompletionData(normalized)) this.sentCompletionData = true;
          this.push(normalized + "\n\n");
        }
      }
      callback();
    } catch (error) {
      error.lastEvent = data?.toString() ?? "[SSEStreamAdapter] no data";
      callback(error);
    }
  }

  _flush(callback: (err?: Error | null) => void) {
    callback();
  }
}

/**
 * The payload of an SSE message, or undefined for messages that carry none:
 * comments, pings, and the stream terminator.
 */
function getCompletionData(message: string): string | undefined {
  const { data } = parseEvent(message);
  if (!data || data === "[DONE]") return undefined;
  return data;
}

// Deliberately excludes errors a retry can't fix, such as a dead key's
// `insufficient_quota`, which would otherwise keep the request in the queue
// until it is killed instead of showing the user what happened.
const RATE_LIMIT_ERROR_TYPES = [
  "rate_limit_error",
  "rate_limit_exceeded",
  "overloaded_error",
  "resource_exhausted",
];
const RATE_LIMIT_TEXT =
  /rate.?limit|too many requests|has been exhausted|quota exceeded/i;

/**
 * True when a message is an upstream error about rate limiting rather than a
 * piece of the completion, in any of the shapes we've seen:
 *
 * - `{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"..."}}`
 * - `{"type":"error","error":{"type":"rate_limit_error",...}}`
 * - a spoofed completion from a proxy built on this codebase, which always
 *   carries the marker written by `response/error-generator.ts`
 */
function isRateLimitEvent(message: string): boolean {
  const data = getCompletionData(message);
  if (!data) return false;

  // The marker only ever appears in an error this family of proxies generated,
  // so the text around it can be matched without worrying about a real
  // completion that happens to discuss rate limits.
  if (data.includes("oai-proxy-error")) {
    return /HTTP 429|too many requests|rate.?limit/i.test(data);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }

  const error = parsed?.error;
  if (!error || typeof error !== "object") return false;

  const code = String(error.code ?? "");
  const status = String(error.status ?? "").toLowerCase();
  const type = String(error.type ?? "").toLowerCase();

  return (
    code === "429" ||
    status === "resource_exhausted" ||
    RATE_LIMIT_ERROR_TYPES.includes(type) ||
    RATE_LIMIT_ERROR_TYPES.includes(code.toLowerCase()) ||
    RATE_LIMIT_TEXT.test(String(error.message ?? ""))
  );
}

// As with rate limits, only errors that a different key or a later attempt can
// clear; a permanently missing model or a rejected prompt must reach the user.
const UNAVAILABLE_ERROR_TYPES = [
  "provider_unavailable",
  "service_unavailable",
  "server_error",
  "api_error",
  "unavailable",
];
const UNAVAILABLE_TEXT =
  /temporarily unavailable|service unavailable|no (?:healthy )?(?:provider|upstream)s? available|upstream (?:is )?unavailable/i;

/**
 * True when a message is an upstream error about the provider being out of
 * capacity rather than a piece of the completion, e.g. the shape upstream
 * proxies send alongside a 503:
 *
 * - `{"error":{"message":"provider temporarily unavailable. Error id: ...","type":"provider_unavailable"}}`
 * - `{"error":{"code":503,"status":"UNAVAILABLE","message":"..."}}`
 */
function isUnavailableEvent(message: string): boolean {
  const data = getCompletionData(message);
  if (!data) return false;

  if (data.includes("oai-proxy-error")) {
    return /HTTP 50[0234]|service unavailable|temporarily unavailable/i.test(
      data
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }

  const error = parsed?.error;
  if (!error || typeof error !== "object") return false;

  const code = String(error.code ?? "");
  const status = String(error.status ?? "").toLowerCase();
  const type = String(error.type ?? "").toLowerCase();

  return (
    code === "503" ||
    status === "unavailable" ||
    status === "service_unavailable" ||
    UNAVAILABLE_ERROR_TYPES.includes(type) ||
    UNAVAILABLE_ERROR_TYPES.includes(code.toLowerCase()) ||
    UNAVAILABLE_TEXT.test(String(error.message ?? ""))
  );
}

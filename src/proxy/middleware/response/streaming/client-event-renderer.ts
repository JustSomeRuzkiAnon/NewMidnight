import { Request } from "express";
import { toAnthropicStopReason } from "../../../../shared/api-schemas/anthropic";
import { OpenAIChatCompletionStreamEvent } from "./index";

/**
 * Renders the events of a stream in the format the client asked for, when that
 * differs from the upstream's.
 *
 * Transformers convert an upstream's events into OpenAI events, which is all a
 * client needs when it speaks OpenAI itself. A client that speaks Gemini or the
 * Anthropic Messages API to an OpenAI-compatible upstream needs the opposite
 * conversion, and it can't be done by a transformer: Anthropic's format wraps
 * the content in several enclosing events, while a transformer may only emit
 * one event per upstream event. Rendering here also keeps the event aggregator
 * fed with the OpenAI events it knows how to collapse.
 */
export type ClientEventRenderer = {
  /** SSE text for one event, in the client's format. */
  render(event: OpenAIChatCompletionStreamEvent): string;
  /** Whatever the client's format needs to close a well-formed stream. */
  finish(): string;
};

export function createClientEventRenderer(
  req: Request
): ClientEventRenderer | undefined {
  if (req.outboundApi !== "openai") return undefined;

  switch (req.inboundApi) {
    case "google-ai":
      return createGoogleAIRenderer();
    case "anthropic-chat":
      return createAnthropicChatRenderer(req);
    default:
      return undefined;
  }
}

/** Gemini streams one self-contained candidate per event and needs no framing. */
function createGoogleAIRenderer(): ClientEventRenderer {
  return {
    render(event) {
      const choice = event.choices?.[0];
      const candidate: Record<string, any> = {
        content: { parts: [{ text: choice?.delta?.content ?? "" }], role: "model" },
        index: 0,
        safetyRatings: [],
      };
      if (choice?.finish_reason) {
        candidate.finishReason = String(choice.finish_reason).toUpperCase();
      }

      const payload: Record<string, any> = { candidates: [candidate] };
      const usage = (event as any).usage;
      if (usage) {
        payload.usageMetadata = {
          promptTokenCount: usage.prompt_tokens || 0,
          candidatesTokenCount: usage.completion_tokens || 0,
          totalTokenCount: usage.total_tokens || 0,
        };
      }
      return `data: ${JSON.stringify(payload)}\n\n`;
    },
    finish: () => "",
  };
}

/**
 * The Messages API wraps the content in a message and a content block, each
 * with its own start and stop event, and names every event in an `event:` line.
 */
function createAnthropicChatRenderer(req: Request): ClientEventRenderer {
  const id = `msg_${req.id}`;
  let started = false;
  let stopped = false;

  const sse = (type: string, data: Record<string, any>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

  const start = (model?: string) => {
    started = true;
    return (
      sse("message_start", {
        message: {
          id,
          type: "message",
          role: "assistant",
          content: [],
          model: model || req.body?.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: req.promptTokens ?? 0, output_tokens: 0 },
        },
      }) +
      sse("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      })
    );
  };

  const stop = (finishReason?: string | null) => {
    stopped = true;
    return (
      sse("content_block_stop", { index: 0 }) +
      sse("message_delta", {
        delta: {
          stop_reason: toAnthropicStopReason(finishReason),
          stop_sequence: null,
        },
        usage: { output_tokens: req.outputTokens ?? 0 },
      }) +
      sse("message_stop", {})
    );
  };

  return {
    render(event) {
      if (stopped) return "";

      const choice = event.choices?.[0];
      let out = started ? "" : start(event.model);

      if (choice?.delta?.content) {
        out += sse("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: choice.delta.content },
        });
      }
      if (choice?.finish_reason) {
        out += stop(choice.finish_reason);
      }
      return out;
    },
    // An upstream that ends the stream without a finish_reason would otherwise
    // leave the client waiting for the events that close the message.
    finish() {
      if (stopped) return "";
      return (started ? "" : start()) + stop(null);
    },
  };
}

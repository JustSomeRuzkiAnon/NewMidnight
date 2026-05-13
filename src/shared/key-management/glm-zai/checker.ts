import { GlmZaiKey } from "./provider";
import { logger } from "../../../logger";
import { assertNever } from "../../utils";

const CHECK_TIMEOUT = 10000;
const SERVER_ERROR_RETRY_DELAY = 5000;
const MAX_SERVER_ERROR_RETRIES = 2;
const CONNECTION_ERROR_RETRY_DELAY = 10000;
const MAX_CONNECTION_ERROR_RETRIES = 2;

const serverErrorCounts: Record<string, number> = {};
const connectionErrorCounts: Record<string, number> = {};

export class GlmZaiKeyChecker {
  private log = logger.child({ module: "key-checker", service: "glm-zai" });

  constructor(private readonly update: (hash: string, key: Partial<GlmZaiKey>) => void) {}

  public async checkKey(key: GlmZaiKey): Promise<void> {
    try {
      const result = await this.validateKey(key);

      if (connectionErrorCounts[key.hash]) {
        delete connectionErrorCounts[key.hash];
      }

      if (result === "server_error") {
        const currentCount = (serverErrorCounts[key.hash] || 0) + 1;
        serverErrorCounts[key.hash] = currentCount;

        if (currentCount <= MAX_SERVER_ERROR_RETRIES) {
          this.log.info(
            { hash: key.hash, retryCount: currentCount },
            `Server error detected, scheduling retry ${currentCount} of ${MAX_SERVER_ERROR_RETRIES} in ${SERVER_ERROR_RETRY_DELAY/1000} seconds`
          );

          setTimeout(() => {
            this.log.info({ hash: key.hash }, "Retrying key check after server error");
            this.checkKey(key);
          }, SERVER_ERROR_RETRY_DELAY);

          this.update(key.hash, {
            lastChecked: Date.now(),
          });

          return;
        } else {
          this.log.warn(
            { hash: key.hash, retries: currentCount },
            "Key failed server error checks multiple times, marking as invalid"
          );

          delete serverErrorCounts[key.hash];
          this.handleCheckResult(key, "invalid");
          return;
        }
      } else {
        if (serverErrorCounts[key.hash]) {
          delete serverErrorCounts[key.hash];
        }

        this.handleCheckResult(key, result);
      }
    } catch (error) {
      const currentCount = (connectionErrorCounts[key.hash] || 0) + 1;
      connectionErrorCounts[key.hash] = currentCount;

      if (currentCount <= MAX_CONNECTION_ERROR_RETRIES) {
        this.log.warn(
          { error, hash: key.hash, retryCount: currentCount },
          `Failed to check key status, scheduling retry ${currentCount} of ${MAX_CONNECTION_ERROR_RETRIES} in ${CONNECTION_ERROR_RETRY_DELAY/1000} seconds`
        );

        setTimeout(() => {
          this.log.info({ hash: key.hash }, "Retrying key check after connection error");
          this.checkKey(key);
        }, CONNECTION_ERROR_RETRY_DELAY);

        this.update(key.hash, {
          lastChecked: Date.now(),
        });
      } else {
        this.log.warn(
          { error, hash: key.hash, retries: currentCount },
          "Key failed connection checks multiple times, marking as invalid"
        );

        delete connectionErrorCounts[key.hash];

        this.update(key.hash, {
          isDisabled: true,
          isRevoked: true,
          lastChecked: Date.now(),
        });
      }
    }
  }

  private async validateKey(key: GlmZaiKey): Promise<"valid" | "invalid" | "quota" | "server_error"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

    try {
      const response = await fetch("https://api.z.ai/api/paas/v4/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key.key}`,
        },
        body: JSON.stringify({
          model: "glm-4.5",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 5,
        }),
        signal: controller.signal,
      });

      const rateLimit = {
        limit: parseInt(response.headers.get("x-ratelimit-limit") || "500"),
        remaining: parseInt(response.headers.get("x-ratelimit-remaining") || "499"),
      };

      switch (response.status) {
        case 200:
          this.log.debug(
            { key: key.hash, rateLimit },
            "Key check successful, updating rate limit info"
          );
          return "valid";
        case 400:
          this.log.warn({ hash: key.hash }, "Key validation failed (bad request)");
          return "invalid";
        case 401:
          this.log.warn({ hash: key.hash }, "Key is invalid (authentication failed)");
          return "invalid";
        case 402:
          this.log.warn({ hash: key.hash }, "Key has insufficient balance");
          return "quota";
        case 429:
          this.log.warn({ key: key.hash }, "Key is rate limited or invalid");
          return "quota";
        case 500:
          this.log.warn({ hash: key.hash }, "Server error when checking key");
          return "server_error";
        case 503:
          this.log.warn({ hash: key.hash }, "Server overloaded when checking key");
          return "server_error";
        default:
          this.log.warn(
            { status: response.status, hash: key.hash },
            "Unexpected status code while checking key"
          );
          return "invalid";
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private handleCheckResult(
    key: GlmZaiKey,
    result: "valid" | "invalid" | "quota" | "server_error"
  ): void {
    switch (result) {
      case "valid":
        this.update(key.hash, {
          isDisabled: false,
          lastChecked: Date.now(),
        });
        break;
      case "invalid":
        this.log.warn({ hash: key.hash }, "Key is invalid");
        this.update(key.hash, {
          isDisabled: true,
          isRevoked: true,
          lastChecked: Date.now(),
        });
        break;
      case "quota":
        this.log.warn({ hash: key.hash }, "Key has exceeded its quota");
        this.update(key.hash, {
          isDisabled: true,
          isOverQuota: true,
          lastChecked: Date.now(),
        });
        break;
      case "server_error":
        this.log.warn({ hash: key.hash }, "Server error when checking key");
        this.update(key.hash, {
          lastChecked: Date.now(),
        });
        break;
      default:
        assertNever(result);
    }
  }
}

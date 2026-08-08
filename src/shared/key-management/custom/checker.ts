import { CustomKey } from "./provider";
import { logger } from "../../../logger";
import { assertNever } from "../../utils";
import { CustomProvider, getProviderUrl } from "../../custom-providers";

const CHECK_TIMEOUT = 10000;
const SERVER_ERROR_RETRY_DELAY = 5000; // 5 seconds
const MAX_SERVER_ERROR_RETRIES = 2;
const CONNECTION_ERROR_RETRY_DELAY = 10000; // 10 seconds
const MAX_CONNECTION_ERROR_RETRIES = 2; // 3 total attempts (initial + 2 retries)

// Track server error counts for each key
const serverErrorCounts: Record<string, number> = {};
// Track connection error counts for each key
const connectionErrorCounts: Record<string, number> = {};

/**
 * Generic key checker for custom providers. Their upstreams are arbitrary, so
 * the check only establishes that the key gets past the upstream's auth, using
 * a model listing rather than a completion so it doesn't consume any quota.
 */
export class CustomKeyChecker {
  private log;

  constructor(
    private readonly provider: CustomProvider,
    private readonly update: (hash: string, key: Partial<CustomKey>) => void
  ) {
    this.log = logger.child({
      module: "key-checker",
      service: "custom",
      provider: provider.id,
    });
  }

  public async checkKey(key: CustomKey): Promise<void> {
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
            `Server error detected, scheduling retry ${currentCount} of ${MAX_SERVER_ERROR_RETRIES} in ${SERVER_ERROR_RETRY_DELAY / 1000} seconds`
          );

          setTimeout(() => {
            this.log.info({ hash: key.hash }, "Retrying key check after server error");
            this.checkKey(key);
          }, SERVER_ERROR_RETRY_DELAY);

          this.update(key.hash, { lastChecked: Date.now() });
          return;
        }

        this.log.warn(
          { hash: key.hash, retries: currentCount },
          "Key failed server error checks multiple times, marking as invalid"
        );
        delete serverErrorCounts[key.hash];
        this.handleCheckResult(key, "invalid");
        return;
      }

      if (serverErrorCounts[key.hash]) {
        delete serverErrorCounts[key.hash];
      }

      this.handleCheckResult(key, result);
    } catch (error) {
      const currentCount = (connectionErrorCounts[key.hash] || 0) + 1;
      connectionErrorCounts[key.hash] = currentCount;

      if (currentCount <= MAX_CONNECTION_ERROR_RETRIES) {
        this.log.warn(
          { error, hash: key.hash, retryCount: currentCount },
          `Failed to check key status, scheduling retry ${currentCount} of ${MAX_CONNECTION_ERROR_RETRIES} in ${CONNECTION_ERROR_RETRY_DELAY / 1000} seconds`
        );

        setTimeout(() => {
          this.log.info({ hash: key.hash }, "Retrying key check after connection error");
          this.checkKey(key);
        }, CONNECTION_ERROR_RETRY_DELAY);

        this.update(key.hash, { lastChecked: Date.now() });
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

  private async validateKey(
    key: CustomKey
  ): Promise<"valid" | "invalid" | "quota" | "server_error"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT);
    const url = getProviderUrl(this.provider, "/v1/models");

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key.key}`,
        },
        signal: controller.signal,
      });

      switch (response.status) {
        case 200:
          this.log.debug({ key: key.hash, url }, "Key check successful");
          return "valid";
        case 401:
        case 403:
          this.log.warn(
            { hash: key.hash, url, status: response.status },
            "Key was rejected by the upstream"
          );
          return "invalid";
        case 402:
          this.log.warn({ hash: key.hash }, "Key has insufficient balance");
          return "quota";
        case 429:
          this.log.warn({ key: key.hash }, "Key is rate limited");
          return "valid";
        case 404:
        case 405:
          // Auth passed; the upstream just doesn't serve a model listing here.
          this.log.debug(
            { key: key.hash, url, status: response.status },
            "Upstream has no model listing, but the key was accepted"
          );
          return "valid";
        case 500:
        case 502:
        case 503:
        case 504:
          this.log.warn(
            { hash: key.hash, status: response.status },
            "Server error when checking key"
          );
          return "server_error";
        default:
          this.log.warn(
            { status: response.status, hash: key.hash },
            "Unexpected status code while checking key"
          );
          return "valid";
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private handleCheckResult(
    key: CustomKey,
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
        // This case is handled in checkKey with retries.
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

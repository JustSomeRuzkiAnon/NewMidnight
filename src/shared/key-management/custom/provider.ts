import { Key, KeyProvider } from "..";
import { CustomKeyChecker } from "./checker";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { ModelFamily } from "../../models";
import { CustomProvider, resolveProviderKeys } from "../../custom-providers";

export interface CustomKey extends Key {
  readonly service: "custom";
  /** Id of the provider this key belongs to; also its model family. */
  readonly providerId: string;
  isOverQuota: boolean;
}

/**
 * Key provider for a single custom provider. Unlike the built-in providers,
 * several instances of this class coexist -- one per entry in the providers
 * file -- so lookups are keyed by `providerId` rather than by service.
 */
export class CustomKeyProvider implements KeyProvider<CustomKey> {
  readonly service = "custom";
  readonly providerId: string;

  private keys: CustomKey[] = [];
  private checker?: CustomKeyChecker;
  private log;
  /**
   * Per-key state for the provider's `rate-limit` cap, keyed by key hash. The
   * minute is counted from the key's first request rather than from a shared
   * clock, so a key that has been idle can always be used immediately.
   */
  private readonly windows = new Map<
    string,
    { startedAt: number; count: number }
  >();
  /**
   * Requests currently using each key, for the provider's `concurrency` cap.
   * Slots are held by request id so that a retry, which is the same request
   * being assigned a key again, replaces its old slot instead of taking a
   * second one.
   */
  private readonly inFlight = new Map<string, Set<string>>();

  constructor(private readonly provider: CustomProvider) {
    this.providerId = provider.id;
    this.log = logger.child({
      module: "key-provider",
      service: this.service,
      provider: provider.id,
    });

    for (const key of resolveProviderKeys(provider)) {
      this.keys.push({
        key,
        service: this.service,
        providerId: provider.id,
        modelFamilies: [provider.id as ModelFamily],
        isDisabled: false,
        isRevoked: false,
        promptCount: 0,
        lastUsed: 0,
        lastChecked: 0,
        hash: this.hashKey(key),
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        tokenUsage: {},
        isOverQuota: false,
      });
    }
  }

  private hashKey(key: string): string {
    return require("crypto").createHash("sha256").update(key).digest("hex");
  }

  public init() {
    if (this.keys.length === 0) return;
    const shouldCheck = this.provider.checkKeys ?? config.checkKeys;
    if (!shouldCheck) {
      this.log.warn("Key checking is disabled. Keys will not be verified.");
      return;
    }
    this.checker = new CustomKeyChecker(this.provider, this.update.bind(this));
    for (const key of this.keys) {
      void this.checker.checkKey(key);
    }
  }

  public get(_model: string): CustomKey {
    const now = Date.now();
    const availableKeys = this.keys.filter((k) => !k.isDisabled);
    if (availableKeys.length === 0) {
      throw new Error(`No ${this.providerId} keys available`);
    }

    // Keys that have spent their minute's budget or are already busy with as
    // many requests as they may take are skipped. Queued requests don't reach
    // this point while every key is blocked -- getLockoutPeriod holds them in
    // the queue -- but unqueued callers such as the model listing still need a
    // key, so they fall back to the whole pool rather than failing.
    // Only the configured caps narrow the pool here. The short reuse throttle
    // is deliberately not considered: it is a queue-level pacing hint, and
    // treating it as a hard constraint would make every key look unusable right
    // after it was handed out, sending us into the fallback below.
    const free = availableKeys.filter(
      (k) => this.getRateLimitWait(k, now) === 0 && !this.isAtCapacity(k)
    );
    const pool = free.length > 0 ? free : availableKeys;

    const key = pool[Math.floor(Math.random() * pool.length)];
    key.lastUsed = now;
    this.countRequest(key, now);
    this.throttle(key.hash);
    return { ...key };
  }

  public list(): Omit<CustomKey, "key">[] {
    return this.keys.map(({ key, ...rest }) => rest);
  }

  public disable(key: CustomKey): void {
    const found = this.keys.find((k) => k.hash === key.hash);
    if (found) {
      found.isDisabled = true;
    }
  }

  public update(hash: string, update: Partial<CustomKey>): void {
    const key = this.keys.find((k) => k.hash === hash);
    if (key) {
      Object.assign(key, update);
    }
  }

  public available(): number {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public incrementUsage(
    keyHash: string,
    modelFamily: ModelFamily,
    usage: { input: number; output: number }
  ) {
    const key = this.keys.find((k) => k.hash === keyHash);
    if (!key) return;

    key.promptCount++;

    if (!key.tokenUsage) {
      key.tokenUsage = {};
    }
    if (!key.tokenUsage[modelFamily]) {
      key.tokenUsage[modelFamily] = { input: 0, output: 0 };
    }

    const currentFamilyUsage = key.tokenUsage[modelFamily]!;
    currentFamilyUsage.input += usage.input;
    currentFamilyUsage.output += usage.output;
  }

  /**
   * Upon being rate limited, a key will be locked out for this many milliseconds
   * while we wait for other concurrent requests to finish.
   */
  private static readonly RATE_LIMIT_LOCKOUT = 2000;
  /**
   * Upon assigning a key, we will wait this many milliseconds before allowing it
   * to be used again. This is to prevent the queue from flooding a key with too
   * many requests while we wait to learn whether previous ones succeeded.
   */
  private static readonly KEY_REUSE_DELAY = 500;
  /** Length of the window the `rate-limit` cap is counted over. */
  private static readonly RATE_LIMIT_WINDOW = 60000;
  /**
   * How long to hold the queue when the only thing blocking a key is the
   * `concurrency` cap. Unlike a rate limit this has no deadline -- it ends when
   * some request finishes -- so the queue just rechecks shortly.
   */
  private static readonly CONCURRENCY_RECHECK = 250;

  /**
   * Milliseconds until this key may be used again under the provider's
   * `rate-limit` cap, or 0 if it still has budget in its current minute (or the
   * provider has no such cap).
   */
  private getRateLimitWait(key: CustomKey, now: number): number {
    const limit = this.provider.rateLimit;
    if (limit <= 0) return 0;

    const window = this.windows.get(key.hash);
    if (!window) return 0;

    const elapsed = now - window.startedAt;
    if (elapsed >= CustomKeyProvider.RATE_LIMIT_WINDOW) return 0;
    if (window.count < limit) return 0;
    return CustomKeyProvider.RATE_LIMIT_WINDOW - elapsed;
  }

  /** Counts a request against the key's minute, starting a new one if the
   * previous has elapsed. */
  private countRequest(key: CustomKey, now: number): void {
    if (this.provider.rateLimit <= 0) return;

    const window = this.windows.get(key.hash);
    if (!window || now - window.startedAt >= CustomKeyProvider.RATE_LIMIT_WINDOW) {
      this.windows.set(key.hash, { startedAt: now, count: 1 });
      return;
    }
    window.count++;

    if (window.count >= this.provider.rateLimit) {
      this.log.debug(
        { key: key.hash, count: window.count, limit: this.provider.rateLimit },
        "Key has spent its per-minute request budget"
      );
    }
  }

  /** Whether the key is already busy with as many requests as it may take. */
  private isAtCapacity(key: CustomKey): boolean {
    const limit = this.provider.concurrency;
    if (limit <= 0) return false;
    return (this.inFlight.get(key.hash)?.size ?? 0) >= limit;
  }

  /**
   * Milliseconds the queue should wait before offering this key another
   * request, taking in the upstream's own rate limiting as well as the
   * provider's `rate-limit` and `concurrency` caps.
   */
  private getKeyWait(key: CustomKey, now: number): number {
    return Math.max(
      key.rateLimitedUntil - now,
      this.getRateLimitWait(key, now),
      this.isAtCapacity(key) ? CustomKeyProvider.CONCURRENCY_RECHECK : 0
    );
  }

  /**
   * Gives the request one of `key`'s concurrency slots, releasing any slot it
   * held before -- a retried request is assigned a key again and must not end
   * up holding two.
   */
  public acquire(keyHash: string, requestId: string): void {
    this.release(requestId);

    let holders = this.inFlight.get(keyHash);
    if (!holders) {
      holders = new Set();
      this.inFlight.set(keyHash, holders);
    }
    holders.add(requestId);
  }

  /** Frees the slot the request was holding, if any. */
  public release(requestId: string): void {
    for (const [hash, holders] of this.inFlight) {
      if (!holders.delete(requestId)) continue;
      if (holders.size === 0) this.inFlight.delete(hash);
      return;
    }
  }

  /**
   * Time the queue should wait before dispatching another request for this
   * provider: requests are held while every key is rate limited, out of budget
   * under `rate-limit`, or busy under `concurrency`.
   */
  public getLockoutPeriod(family?: ModelFamily): number {
    const activeKeys = this.keys.filter(
      (k) => !k.isDisabled && (!family || k.modelFamilies.includes(family))
    );
    if (activeKeys.length === 0) return 0;

    const now = Date.now();
    const waits = activeKeys.map((k) => this.getKeyWait(k, now));
    if (waits.some((wait) => wait <= 0)) return 0;
    return Math.min(...waits);
  }

  public markRateLimited(keyHash: string) {
    this.log.debug({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const now = Date.now();
    key.rateLimitedAt = now;
    key.rateLimitedUntil = now + CustomKeyProvider.RATE_LIMIT_LOCKOUT;
  }

  public recheck(): void {
    if (!this.checker) return;
    for (const key of this.keys) {
      this.update(key.hash, {
        isOverQuota: false,
        isDisabled: false,
        lastChecked: 0,
      });
      void this.checker.checkKey(key);
    }
  }

  /**
   * Applies a short artificial delay to the key upon dequeueing, in order to
   * prevent it from being immediately assigned to another request before the
   * current one can be dispatched.
   **/
  private throttle(hash: string) {
    const now = Date.now();
    const key = this.keys.find((k) => k.hash === hash)!;

    const currentRateLimit = key.rateLimitedUntil;
    const nextRateLimit = now + CustomKeyProvider.KEY_REUSE_DELAY;

    key.rateLimitedAt = now;
    key.rateLimitedUntil = Math.max(currentRateLimit, nextRateLimit);
  }
}

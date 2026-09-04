import { Key, KeyProvider, createGenericGetLockoutPeriod } from "..";
import { GlmZaiCodingKeyChecker } from "./checker";
import { DEFAULT_QUOTA_WAIT_MS } from "./quota";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { GlmZaiCodingModelFamily, ModelFamily } from "../../models";

export interface GlmZaiCodingKey extends Key {
  readonly service: "glm-zai-coding";
  readonly modelFamilies: GlmZaiCodingModelFamily[];
  isOverQuota: boolean;
  /**
   * When the plan's usage window rolls over and the key becomes usable again,
   * or 0 if it is not parked on a quota.
   */
  quotaResetsAt: number;
}

export class GlmZaiCodingKeyProvider implements KeyProvider<GlmZaiCodingKey> {
  readonly service = "glm-zai-coding";

  private keys: GlmZaiCodingKey[] = [];
  private checker?: GlmZaiCodingKeyChecker;
  private quotaSweep?: NodeJS.Timeout;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.glmZaiCodingKey?.trim();
    if (!keyConfig) {
      return;
    }

    const keys = keyConfig.split(",").map((k) => k.trim());
    for (const key of keys) {
      if (!key) continue;
      this.keys.push({
        key,
        service: this.service,
        modelFamilies: ["glm-zai-coding"],
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
        quotaResetsAt: 0,
      });
    }
  }

  private hashKey(key: string): string {
    return require("crypto").createHash("sha256").update(key).digest("hex");
  }

  public init() {
    if (this.keys.length === 0) return;

    // Parked keys have to come back whether or not key checking is on: without
    // the checker there is simply nothing to confirm the quota with, so the key
    // returns to the rotation and the next request settles it.
    this.quotaSweep = setInterval(
      () => this.restoreExpiredQuotas(),
      GlmZaiCodingKeyProvider.QUOTA_SWEEP_INTERVAL
    );

    if (!config.checkKeys) {
      this.log.warn(
        "Key checking is disabled. Keys will not be verified."
      );
      return;
    }
    this.checker = new GlmZaiCodingKeyChecker(this.update.bind(this));
    for (const key of this.keys) {
      void this.checker.checkKey(key);
    }
  }

  public get(model: string): GlmZaiCodingKey {
    const availableKeys = this.keys.filter((k) => !k.isDisabled);
    if (availableKeys.length === 0) {
      throw new Error("No GLM-ZAI-CODING keys available");
    }
    const key = availableKeys[Math.floor(Math.random() * availableKeys.length)];
    key.lastUsed = Date.now();
    this.throttle(key.hash);
    return { ...key };
  }

  public list(): Omit<GlmZaiCodingKey, "key">[] {
    return this.keys.map(({ key, ...rest }) => rest);
  }

  public disable(key: GlmZaiCodingKey): void {
    const found = this.keys.find((k) => k.hash === key.hash);
    if (found) {
      found.isDisabled = true;
    }
  }

  public update(hash: string, update: Partial<GlmZaiCodingKey>): void {
    const key = this.keys.find((k) => k.hash === hash);
    if (key) {
      Object.assign(key, update);
    }
  }

  public available(): number {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public incrementUsage(keyHash: string, modelFamily: GlmZaiCodingModelFamily, usage: { input: number; output: number }) {
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

  private static readonly RATE_LIMIT_LOCKOUT = 2000;
  private static readonly KEY_REUSE_DELAY = 500;
  /** How often parked keys are examined for having become usable again. */
  private static readonly QUOTA_SWEEP_INTERVAL = 60 * 1000;

  getLockoutPeriod = createGenericGetLockoutPeriod(() => this.keys);

  /**
   * Parks a key that has spent its plan's usage window until `resetsAt`, rather
   * than disabling it permanently the way a revoked key is. `restoreExpiredQuotas`
   * brings it back once that moment passes.
   */
  public markOverQuota(keyHash: string, resetsAt?: number): void {
    const key = this.keys.find((k) => k.hash === keyHash);
    if (!key) return;

    const resumesAt = resetsAt && resetsAt > Date.now()
      ? resetsAt
      : Date.now() + DEFAULT_QUOTA_WAIT_MS;

    this.log.warn(
      { key: key.hash, resumesAt: new Date(resumesAt).toISOString() },
      "Key has spent its usage quota; parking it until the quota resets"
    );

    this.update(key.hash, {
      isDisabled: true,
      isOverQuota: true,
      quotaResetsAt: resumesAt,
    });
  }

  /**
   * Returns keys whose usage window has rolled over to the rotation. With key
   * checking on the key is verified first, so a quota that has not actually
   * reset parks it again with the upstream's new timestamp.
   */
  private restoreExpiredQuotas(): void {
    const now = Date.now();
    const restored = this.keys.filter(
      (k) => k.isOverQuota && !k.isRevoked && k.quotaResetsAt > 0 && k.quotaResetsAt <= now
    );

    for (const key of restored) {
      this.log.info(
        { key: key.hash },
        "Usage quota should have reset; returning key to rotation"
      );
      this.update(key.hash, {
        isOverQuota: false,
        isDisabled: false,
        quotaResetsAt: 0,
        lastChecked: 0,
      });
      if (this.checker) void this.checker.checkKey(key);
    }
  }

  public markRateLimited(keyHash: string) {
    this.log.debug({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const now = Date.now();
    key.rateLimitedAt = now;
    key.rateLimitedUntil = now + GlmZaiCodingKeyProvider.RATE_LIMIT_LOCKOUT;
  }

  public recheck(): void {
    if (!this.checker || !config.checkKeys) return;
    for (const key of this.keys) {
      this.update(key.hash, {
        isOverQuota: false,
        isDisabled: false,
        quotaResetsAt: 0,
        lastChecked: 0
      });
      void this.checker.checkKey(key);
    }
  }

  private throttle(hash: string) {
    const now = Date.now();
    const key = this.keys.find((k) => k.hash === hash)!;

    const currentRateLimit = key.rateLimitedUntil;
    const nextRateLimit = now + GlmZaiCodingKeyProvider.KEY_REUSE_DELAY;

    key.rateLimitedAt = now;
    key.rateLimitedUntil = Math.max(currentRateLimit, nextRateLimit);
  }
}

import crypto from "crypto";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { PaymentRequiredError } from "../../errors";
import { createGenericGetLockoutPeriod, Key, KeyProvider } from "..";
import { prioritizeKeys } from "../prioritize-keys";
import { OpenRouterKeyChecker } from "./checker";
import { ModelFamily, OPENROUTER_FAMILY_MAP } from "../../models";
export interface OpenRouterKey extends Key {
  readonly service: "openrouter";
  isFreeTier: boolean;
  balance: number;
  creditLimit: number | null;
  usage: number;
  rpm: number;
  tier: "unlimited" | "limited" | "restricted" | "deadkey";
}

const RATE_LIMIT_LOCKOUT = 2000;
const KEY_REUSE_DELAY = 500;

export function getOpenRouterModelFamily(modelId: string): string {
  if (!modelId) return "OpRout_Other";
  
  for (const [prefix, family] of Object.entries(OPENROUTER_FAMILY_MAP)) {
    if (modelId.startsWith(prefix)) {
      return family;
    }
  }
  
  console.warn(`[Mapping] '${modelId}' fell through to OpRout_Other`);
  return "OpRout_Other";
}

export class OpenRouterKeyProvider implements KeyProvider<OpenRouterKey> {
  readonly service = "openrouter";
  private keys: OpenRouterKey[] = [];
  private checker?: OpenRouterKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.openRouterKey?.trim();
    if (!keyConfig) {
      this.log.warn("OPENROUTER_KEY is not set.");
      return;
    }
    let bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (const key of bareKeys) {
      this.keys.push({
        key,
        service: this.service,
        modelFamilies: ["openrouter"],
        isDisabled: false,
        isRevoked: false,
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        hash: `or-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 8)}`,
        lastChecked: 0,
        isFreeTier: true, 
        balance: 0,
        creditLimit: 0,
        usage: 0,
        rpm: 0,
        tier: "restricted", // До первой проверки считаем ограниченным
        tokenUsage: {},
      });
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded OpenRouter keys.");
  }

  public init() {
    if (config.checkKeys) {
      this.checker = new OpenRouterKeyChecker(this.keys, this.update.bind(this));
      this.checker.start();
    } else {
        // Если проверка ключей отключена в конфиге, принудительно ставим всем unlimited,
        // иначе они так и останутся restricted и не смогут юзать платные модели.
        this.keys.forEach(k => {
            k.tier = "unlimited";
            k.balance = 999; 
        });
    }
  }

  public list() { return this.keys.map((k) => Object.freeze({ ...k, key: undefined })); }

  public get(model: string) {
    // 1. Берем все активные ключи
    let availableKeys = this.keys.filter((k) => !k.isDisabled && !k.isRevoked);
    
    if (availableKeys.length === 0) {
      throw new PaymentRequiredError("No OpenRouter keys available.");
    }

    const isFreeModel = model.endsWith(":free");

    if (isFreeModel) {
      // Для бесплатных моделей - любые живые ключи
      availableKeys = availableKeys.filter((k) => k.tier !== "deadkey");
    } else {
      // Для платных моделей
      availableKeys = availableKeys.filter((k) => {
        // Мертвые сразу нет
        if (k.tier === "deadkey") return false;
        
        // Unlimited (Prepaid) и Limited (Monthly) - да
        if (k.balance > 0) return true;
        
        // (Например, юзер закинул $5, но OpenRouter все еще считает его Free Tier по каким-то причинам)
        if (k.tier === "unlimited") return true;

        return false;
      });

      if (availableKeys.length === 0) {
        // Лог для отладки, чтобы ты видел в консоли, почему ключи отброшены
        const debugInfo = this.keys.map(k => `${k.hash.slice(0,4)}:${k.tier}($${k.balance.toFixed(2)})`).join(", ");
        this.log.warn({ model, debugInfo }, "No paid keys available for paid model");
        throw new PaymentRequiredError("No paid OpenRouter keys available.");
      }
    }

    const selectedKey = prioritizeKeys(availableKeys)[0];
    selectedKey.lastUsed = Date.now();
    this.throttle(selectedKey.hash);
    return { ...selectedKey };
  }

  public update(hash: string, update: Partial<OpenRouterKey>) {
    const key = this.keys.find((k) => k.hash === hash)!;
    Object.assign(key, { lastChecked: Date.now(), ...update });
  }

  public incrementUsage(keyHash: string, model: string, tokens: { input: number; output: number }) {
    const key = this.keys.find((k) => k.hash === keyHash);
    if (!key) return;
    key.promptCount++;
    
    const family = getOpenRouterModelFamily(model) as ModelFamily;
    
    if (!key.tokenUsage) key.tokenUsage = {};
    if (!key.tokenUsage[family]) key.tokenUsage[family] = { input: 0, output: 0 };
    key.tokenUsage[family]!.input += tokens.input;
    key.tokenUsage[family]!.output += tokens.output;
  }

  public available() { return this.keys.filter((k) => !k.isDisabled).length; }
  getLockoutPeriod = createGenericGetLockoutPeriod(() => this.keys);
  public markRateLimited(keyHash: string) {
    const key = this.keys.find((k) => k.hash === keyHash)!;
    key.rateLimitedUntil = Date.now() + RATE_LIMIT_LOCKOUT;
  }
  public recheck() {
    this.keys.filter(k => k.isDisabled && !k.isRevoked).forEach(k => this.update(k.hash, { isDisabled: false }));
    this.checker?.scheduleNextCheck();
  }
  private throttle(hash: string) {
    const key = this.keys.find((k) => k.hash === hash)!;
    key.rateLimitedUntil = Math.max(key.rateLimitedUntil, Date.now() + KEY_REUSE_DELAY);
  }
  public disable(key: OpenRouterKey) {
     const k = this.keys.find(k => k.hash === key.hash);
     if (k) k.isDisabled = true;
  }
}
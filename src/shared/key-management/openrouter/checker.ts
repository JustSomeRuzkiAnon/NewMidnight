import { AxiosError } from "axios";
import { getAxiosInstance } from "../../network";
import { KeyCheckerBase } from "../key-checker-base";
import type { OpenRouterKey, OpenRouterKeyProvider } from "./provider";

const axios = getAxiosInstance();
const CHECK_URL = "https://openrouter.ai/api/v1/auth/key";
const CREDITS_URL = "https://openrouter.ai/api/v1/credits";

export class OpenRouterKeyChecker extends KeyCheckerBase<OpenRouterKey> {
  constructor(keys: OpenRouterKey[], updateKey: any) {
    super(keys, {
      service: "openrouter",
      keyCheckPeriod: 3600000, // 1 час
      minCheckInterval: 3000,
      recurringChecksEnabled: true,
      updateKey,
    });
  }

  protected async testKeyOrFail(key: OpenRouterKey) {
    const headers = { Authorization: `Bearer ${key.key}` };

    const [keyResult, creditsResult] = await Promise.allSettled([
      axios.get(CHECK_URL, { headers }),
      axios.get(CREDITS_URL, { headers })
    ]);

    if (keyResult.status === "rejected") {
      throw keyResult.reason; // Если упала проверка ключа — это ошибка
    }
    
    const keyData = keyResult.value.data.data;
    if (!keyData) throw new Error("Invalid response from OpenRouter /auth/key");

    const usage = Number(keyData.usage) || 0;
    const limit = keyData.limit === null ? null : Number(keyData.limit);
    const isFreeTier = !!keyData.is_free_tier;

    // Парсим RPM
    let rpm = 0;
    if (keyData.rate_limit) {
        const requests = Number(keyData.rate_limit.requests) || 0;
        const intervalStr = keyData.rate_limit.interval ? keyData.rate_limit.interval.replace('s', '') : '1';
        const interval = parseInt(intervalStr) || 1;
        rpm = Math.floor(requests / interval) * 60;
    }

    // --- ГЛАВНАЯ МАГИЯ БАЛАНСА ---
    // Если limit === null, это Prepaid ключ (или безлимит). Считаем, что денег куча.
    // Если limit !== null, считаем остаток.
    let balance = 0;
    
    if (creditsResult.status === "fulfilled") {
      const creditsData = creditsResult.value.data.data;
      balance = Number(creditsData?.total_credits) || 0;
    } else {
      this.log.warn({ key: key.hash, error: creditsResult.reason }, "Failed to fetch credits, using fallback calculation");
      balance = limit !== null ? Math.max(0, limit - usage) : 999;
    }

    let tier: OpenRouterKey["tier"] = "deadkey";
    
    const limitReached = limit !== null && usage >= limit;

    if (limitReached) {
        tier = "deadkey";
    } else if (balance > 0) {
        // Если limit === null, это Prepaid (Unlimited). Если limit есть — Monthly (Limited).
        tier = limit === null ? "unlimited" : "limited";
    } else if (isFreeTier) {
        // Денег нет (0), но это Free Tier -> Restricted
        tier = "restricted";
    } else {
        // Денег нет и не Free Tier -> Dead
        tier = "deadkey";
    }

    this.updateKey(key.hash, {
      isFreeTier,
      balance, 
      creditLimit: limit, 
      usage, 
      rpm, 
      tier,
      isDisabled: tier === "deadkey",
      isRevoked: false
    });
    
    this.log.info(
        { key: key.hash, tier, balance: balance.toFixed(4), rpm }, 
        "Checked OpenRouter key"
    );
  }

  protected handleAxiosError(key: OpenRouterKey, error: AxiosError): void {
    if (error.response) {
      const status = error.response.status;
      if (status === 401) {
        return this.updateKey(key.hash, { isDisabled: true, isRevoked: true, tier: "deadkey" });
      }
      if (status === 402) {
        return this.updateKey(key.hash, { isDisabled: true, tier: "deadkey", balance: 0 });
      }
    }
  }
}
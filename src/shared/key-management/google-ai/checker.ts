import { AxiosError } from "axios";
import { GoogleAIModelFamily, getGoogleAIModelFamily } from "../../models";
import { getAxiosInstance } from "../../network";
import { KeyCheckerBase } from "../key-checker-base";
import type { GoogleAIKey, GoogleAIKeyProvider } from "./provider";

const axios = getAxiosInstance();

const MIN_CHECK_INTERVAL = 3 * 1000; // 3 seconds
const KEY_CHECK_PERIOD = 6 * 60 * 60 * 1000; // 3 hours
const LIST_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
const GENERATE_CONTENT_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=%KEY%";
const PRO_MODEL_ID = "gemini-2.5-pro";
const FLASH_PREVIEW_ID = "gemini-3-flash-preview";
const PRO_PREVIEW_ID = "gemini-3.1-pro-preview";
const GENERATE_PRO_CONTENT_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${PRO_MODEL_ID}:generateContent?key=%KEY%`;
const GENERATE_FLASH_PREVIEW_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${FLASH_PREVIEW_ID}:generateContent?key=%KEY%`;
const GENERATE_PRO_PREVIEW_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${PRO_PREVIEW_ID}:generateContent?key=%KEY%`;
const IMAGEN_BILLING_TEST_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict";
/**
 * Free-tier quotas are accounted in Google's billing timezone, so a daily one
 * that is exhausted comes back at the next midnight there and not before.
 */
const QUOTA_RESET_TIMEZONE = "America/Los_Angeles";
/** Shortest recheck to schedule, so a tight quota cannot become a hot loop. */
const MIN_RECHECK_DELAY = 60 * 1000;

type ListModelsResponse = {
  models: {
    name: string;
    baseModelId: string;
    version: string;
    displayName: string;
    description: string;
    inputTokenLimit: number;
    outputTokenLimit: number;
    supportedGenerationMethods: string[];
    temperature: number;
    maxTemperature: number;
    topP: number;
    topK: number;
  }[];
  nextPageToken: string;
};

/** A single entry of a `google.rpc.QuotaFailure` detail. */
type QuotaViolation = {
  quotaId?: string;
  quotaMetric?: string;
  quotaValue?: string;
  quotaDimensions?: Record<string, string>;
};

/**
 * Pulls the machine-readable parts out of a Google API error's `details`: which
 * quota was hit and how long the server wants us to wait. Google rewords the
 * human-readable message, but these structures are stable.
 */
function parseQuotaDetails(details: any[] | undefined) {
  const violations: QuotaViolation[] = [];
  let retryDelayMs = 0;

  for (const detail of details ?? []) {
    const type = String(detail?.["@type"] ?? "");
    if (type.endsWith("google.rpc.QuotaFailure")) {
      violations.push(...(detail.violations ?? []));
    } else if (type.endsWith("google.rpc.RetryInfo")) {
      // Formatted as a protobuf Duration, e.g. "22s" or "22.393415552s".
      const seconds = parseFloat(String(detail.retryDelay ?? ""));
      if (Number.isFinite(seconds) && seconds > 0) {
        retryDelayMs = Math.ceil(seconds * 1000);
      }
    }
  }

  return { violations, retryDelayMs };
}

/**
 * The instant the quota day containing `at` began, in Google's billing
 * timezone. Twice a year a DST change makes this an hour off, which only
 * shifts a recheck by an hour and is not worth a timezone library.
 */
function startOfQuotaDay(at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: QUOTA_RESET_TIMEZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Some ICU builds render midnight as hour 24.
  const secondsIntoDay = (get("hour") % 24) * 3600 + get("minute") * 60 + get("second");
  return at - secondsIntoDay * 1000 - (at % 1000);
}

/** How long until daily quotas reset, from `now`. */
function msUntilDailyQuotaReset(now: number): number {
  return startOfQuotaDay(now + 24 * 60 * 60 * 1000) - now;
}

type UpdateFn = typeof GoogleAIKeyProvider.prototype.update;

export class GoogleAIKeyChecker extends KeyCheckerBase<GoogleAIKey> {
  constructor(keys: GoogleAIKey[], updateKey: UpdateFn) {
    super(keys, {
      service: "google-ai",
      keyCheckPeriod: KEY_CHECK_PERIOD,
      minCheckInterval: MIN_CHECK_INTERVAL,
      recurringChecksEnabled: true,
      updateKey,
    });
  }

  protected async testKeyOrFail(key: GoogleAIKey) {
    const provisionedModels = await this.getProvisionedModels(key);

    // Always test flash model access (existing behaviour)
    await this.testGenerateContent(key);

    // Test if billing is enabled for this key
    const billingEnabled = await this.testBillingEnabled(key);

    // If key claims to support gemini-pro, perform a second layer test with a pro model.
    let effectiveFamilies = [...provisionedModels];
    if (effectiveFamilies.includes("gemini-pro")) {
      const proAccessible = await this.canAccessModel(
        key,
        GENERATE_PRO_CONTENT_URL
      );
      if (!proAccessible) {
        // Remove pro access if invocation fails
        effectiveFamilies = effectiveFamilies.filter((f) => f !== "gemini-pro");
      }
    }

    if (effectiveFamilies.includes("flash-preview")) {
      const proAccessible = await this.canAccessModel(
        key,
        GENERATE_FLASH_PREVIEW_URL
      );
      if (!proAccessible) {
        // Remove pro access if invocation fails
        effectiveFamilies = effectiveFamilies.filter((f) => f !== "flash-preview");
      }
    }

    if (effectiveFamilies.includes("pro-preview")) {
      const proAccessible = await this.canAccessModel(
        key,
        GENERATE_PRO_PREVIEW_URL
      );
      if (!proAccessible) {
        // Remove pro access if invocation fails
        effectiveFamilies = effectiveFamilies.filter((f) => f !== "pro-preview");
        effectiveFamilies = effectiveFamilies.filter((f) => f !== "gemini-images");
      }
    }

    const updates = { modelFamilies: effectiveFamilies, billingEnabled };
    this.updateKey(key.hash, updates);
    this.log.info(
      { key: key.hash, models: effectiveFamilies, ids: key.modelIds?.length, billingEnabled },
      "Checked key."
    );
  }

  private async getProvisionedModels(
    key: GoogleAIKey
  ): Promise<GoogleAIModelFamily[]> {
    const { data } = await axios.get<ListModelsResponse>(
      `${LIST_MODELS_URL}?pageSize=1000&key=${key.key}`
    );
    const models = data.models;

    const ids = new Set<string>();
    const families = new Set<GoogleAIModelFamily>();
    models.forEach(({ name }) => {
      families.add(getGoogleAIModelFamily(name));
      ids.add(name);
    });

    const familiesArray = Array.from(families);

    // ListModels reports every model the API offers, not the ones this key can
    // still afford, so families the proxy took away after a quota error would
    // be handed straight back and immediately fail again.
    const stillOverQuota = this.getActiveOverQuotaFamilies(key);
    const availableFamilies = familiesArray.filter(
      (f) => !stillOverQuota.includes(f)
    );

    this.updateKey(key.hash, {
      modelFamilies: availableFamilies,
      modelIds: Array.from(ids),
      overQuotaFamilies: stillOverQuota,
    });

    return availableFamilies;
  }

  /**
   * The families a quota error took away that are still out, dropping any whose
   * daily quota has rolled over since it was recorded.
   */
  private getActiveOverQuotaFamilies(
    key: GoogleAIKey
  ): GoogleAIModelFamily[] {
    const families = key.overQuotaFamilies ?? [];
    if (!families.length) return [];

    if ((key.overQuotaFamiliesAt ?? 0) < startOfQuotaDay(Date.now())) {
      this.log.info(
        { key: key.hash, families },
        "Daily quota reset since these families were marked over quota; restoring them."
      );
      return [];
    }
    return families;
  }

  private async testGenerateContent(key: GoogleAIKey) {
    const payload = {
      contents: [{ parts: { text: "hello" }, role: "user" }],
      tools: [],
      safetySettings: [],
      generationConfig: { maxOutputTokens: 1 },
    };
    await axios.post(
      GENERATE_CONTENT_URL.replace("%KEY%", key.key),
      payload,
      { validateStatus: (status) => status === 200 }
    );
  }

  private async canAccessModel(
    key: GoogleAIKey,
    modelGenerateUrlTemplate: string
  ): Promise<boolean> {
    const payload = {
      contents: [{ parts: { text: "hi" }, role: "user" }],
      tools: [],
      safetySettings: [],
      generationConfig: { maxOutputTokens: 5 },
    };
    try {
      await axios.post(
        modelGenerateUrlTemplate.replace("%KEY%", key.key),
        payload,
        { validateStatus: (status) => status === 200 }
      );
      return true;
    } catch {
      return false;
    }
  }

  private async testBillingEnabled(key: GoogleAIKey): Promise<boolean> {
    const payload = {
      instances: [{ prompt: "" }]
    };
    try {
      const response = await axios.post(
        IMAGEN_BILLING_TEST_URL,
        payload,
        { validateStatus: () => true, headers: { 'x-goog-api-key': key.key } } // Accept all status codes
      );
      

      if (response.status === 400) {
        const errorMessage = response.data?.error?.message || "";
        // If the error message contains the billing requirement, billing is NOT enabled
        if (errorMessage.includes("Imagen API is only accessible to billed users at this time")) {
          return false;
        }
        // Other 400 errors indicate billing IS enabled (following Python logic)
        return true;
      }
      

      // For other status codes, assume no billing (conservative approach)
      return false;
    } catch (error: any) {
      // Network errors or other issues - assume no billing
      console.error("Error testing billing status:", error, key.key);
      return false;
    }
  }

  /** A `lastChecked` value that makes the key due for a check in `delayMs`. */
  private recheckIn(delayMs: number): number {
    return Date.now() - (KEY_CHECK_PERIOD - delayMs);
  }

  protected handleAxiosError(key: GoogleAIKey, error: AxiosError): void {
    if (error.response && GoogleAIKeyChecker.errorIsGoogleAIError(error)) {
      const httpStatus = error.response.status;
      const { code, message, status, details } = error.response.data.error;

      switch (httpStatus) {
        case 400: {
          const keyDeadMsgs = [
            /please enable billing/i,
            /api key not valid/i,
            /api key expired/i,
            /pass a valid api/i, // This may also indicate an invalid key.
            /api key not found/i, // Explicitly for "not found" keys
          ];
          const text = JSON.stringify(error.response.data.error);
          if (keyDeadMsgs.some((r) => r.test(text))) {
            this.log.warn(
              { key: key.hash, error: text, errorCode: code, httpStatus },
              "Key check returned a 400 error indicating a permanent key issue (e.g., invalid, expired, billing). Disabling and revoking key."
            );
            this.updateKey(key.hash, { isDisabled: true, isRevoked: true });
            return;
          }
          // If it's a 400 but not a key-revoking message, treat as transient.
          this.log.warn(
            { key: key.hash, error: text, errorCode: code, httpStatus },
            "Key check returned a generic 400 error. Treating as transient. Rechecking in 1 minute."
          );
          const recheckInOneMinute = Date.now() - (KEY_CHECK_PERIOD - 60 * 1000);
          this.updateKey(key.hash, { lastChecked: recheckInOneMinute });
          return;
        }
        case 401: // Unauthorized
        case 403: // Forbidden / Permission Denied
          this.log.warn(
            { key: key.hash, status, code, message, details, httpStatus },
            "Key check returned Forbidden/Unauthorized error. Disabling and revoking key."
          );
          this.updateKey(key.hash, { isDisabled: true, isRevoked: true });
          return;
        case 429: { // Resource Exhausted (Rate Limit / Quota)
          const text = JSON.stringify(error.response.data.error);
          const { violations, retryDelayMs } = parseQuotaDetails(details);
          // A zero-valued quota is not a rate limit at all; the key has no
          // allowance for the model and waiting will never change that.
          const noAllowance = violations.some((v) => v.quotaValue === "0");
          const hardQuotaMessages = [
            /GenerateContentRequestsPerMinutePerProjectPerRegion/i, // Often indicates a hard limit or misconfiguration
            /billing account not found/i, // Billing issue presented as 429 sometimes
            /project has been suspended/i, // Project level issue
          ];
          if (noAllowance || hardQuotaMessages.some((r) => r.test(text))) {
            this.log.warn(
              { key: key.hash, error: text, errorCode: code, httpStatus },
              "Key check returned a 429 error indicating a hard quota limit or billing issue. Disabling and marking as over quota, but not revoking."
            );
            this.updateKey(key.hash, { isDisabled: true, isRevoked: false, isOverQuota: true });
            return;
          }

          // A daily quota does not come back for hours, so the old fixed
          // one-minute recheck just spent the next day's allowance on probe
          // requests. Per-minute limits are paced by the server's own
          // RetryInfo instead of a guess.
          const dailyQuota = violations.some((v) =>
            /PerDay/i.test(v.quotaId ?? "")
          );
          const recheckDelay = dailyQuota
            ? msUntilDailyQuotaReset(Date.now())
            : Math.max(retryDelayMs, MIN_RECHECK_DELAY);

          this.log.warn(
            {
              key: key.hash,
              status,
              code,
              message,
              details,
              httpStatus,
              dailyQuota,
              quotaIds: violations.map((v) => v.quotaId),
              recheckInMinutes: Math.round(recheckDelay / 60000),
            },
            "Key is rate limited (429). Rechecking when its quota should have recovered."
          );
          this.updateKey(key.hash, { lastChecked: this.recheckIn(recheckDelay) });
          return;
        }
        case 500: // Internal Server Error
        case 503: // Service Unavailable
        case 504: // Deadline Exceeded
          this.log.warn(
            { key: key.hash, status, code, message, details, httpStatus },
            `Key check encountered a server-side error (${httpStatus}). Treating as transient. Rechecking in 1 minute.`
          );
          const recheck5xx = Date.now() - (KEY_CHECK_PERIOD - 60 * 1000);
          this.updateKey(key.hash, { lastChecked: recheck5xx });
          return;
      }

      // Fallthrough for other unexpected Google AI API errors
      this.log.error(
        { key: key.hash, status, code, message, details, httpStatus },
        "Encountered unexpected Google AI error status while checking key. This may indicate a change in the API. Rechecking in 1 minute."
      );
      const recheckUnexpected = Date.now() - (KEY_CHECK_PERIOD - 60 * 1000);
      this.updateKey(key.hash, { lastChecked: recheckUnexpected });
      return;
    }

    // Network errors (not HTTP errors from Google AI)
    this.log.error(
      { key: key.hash, error: error.message },
      "Network error while checking key; trying this key again in 1 minute."
    );
    const recheckNetworkError = Date.now() - (KEY_CHECK_PERIOD - 60 * 1000); // Corrected to 60 * 1000
    return this.updateKey(key.hash, { lastChecked: recheckNetworkError });
  }

  static errorIsGoogleAIError(
    error: AxiosError
  ): error is AxiosError<GoogleAIError> {
    const data = error.response?.data as any;
    return data?.error?.code || data?.error?.status;
  }
}

type GoogleAIError = {
  error: {
    code: string;
    message: string;
    status: string;
    details: any[];
  };
};

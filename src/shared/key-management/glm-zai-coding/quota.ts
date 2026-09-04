/**
 * The Z.ai coding plan enforces a rolling usage window rather than a per-minute
 * rate limit. When it is spent the upstream answers 429 with error code 1308 and
 * a message that names the moment the window rolls over:
 *
 *   Usage limit reached for 5 hour. Your limit will reset at 2026-09-03 21:35:41
 *
 * The key is unusable until then and usable again afterwards, so we park it and
 * bring it back rather than disabling it for good.
 */

/**
 * The reset timestamp carries no zone. Observed responses put it eight hours
 * ahead of the moment the error was received, which is Beijing time -- the zone
 * Z.ai reports in. Guessing wrong is not fatal: an early guess just means the
 * key returns, gets another 429, and is parked again with a fresh timestamp.
 */
const ZAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Never park a key for longer than this, whatever the message claims. */
const MAX_QUOTA_WAIT_MS = 24 * 60 * 60 * 1000;
/** Used when the message says the quota is spent but not when it returns. */
export const DEFAULT_QUOTA_WAIT_MS = 30 * 60 * 1000;

const RESET_AT = /reset at\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/i;
const WINDOW = /limit reached for\s+(\d+)\s*hour/i;

/** Whether a 429 is the plan's usage window rather than an ordinary rate limit. */
export function isUsageLimitError(message: string, code?: string | number): boolean {
  if (String(code ?? "") === "1308") return true;
  return /usage limit reached/i.test(message);
}

/**
 * Time the plan's usage window rolls over, read from the upstream's message.
 * Falls back to the window length it names, then to a fixed wait, so a key is
 * always given some time rather than being lost.
 */
export function parseQuotaResetTime(message: string, now = Date.now()): number {
  const at = message.match(RESET_AT);
  if (at) {
    const [, year, month, day, hour, minute, second] = at.map(Number) as unknown as number[];
    const resetsAt =
      Date.UTC(year, month - 1, day, hour, minute, second) - ZAI_UTC_OFFSET_MS;
    if (resetsAt > now) return Math.min(resetsAt, now + MAX_QUOTA_WAIT_MS);
  }

  const window = message.match(WINDOW);
  if (window) {
    const hours = Number(window[1]);
    if (hours > 0) return now + Math.min(hours * 60 * 60 * 1000, MAX_QUOTA_WAIT_MS);
  }

  return now + DEFAULT_QUOTA_WAIT_MS;
}

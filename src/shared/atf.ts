import { config } from "../config";

/**
 * ATF points at another OpenAI-compatible reverse proxy rather than a vendor
 * API. Both the address and the path layout are configurable so the endpoint
 * can be repointed (ATF_BASE_URL / ATF_PATH_STYLE) without code changes.
 */

/** Base URL of the upstream proxy, never with a trailing slash. */
export function getAtfBaseUrl(): string {
  return config.atfBaseUrl.trim().replace(/\/+$/, "");
}

/**
 * Normalizes a router-relative path (e.g. `/v1/chat/completions` or
 * `/models`) to the path layout the upstream proxy expects.
 */
export function buildAtfPath(path: string): string {
  const withoutV1 = path.replace(/^\/v1(?=\/|$)/, "");
  const rest = withoutV1.startsWith("/") ? withoutV1 : `/${withoutV1}`;
  return config.atfPathStyle === "bare" ? rest : `/v1${rest}`;
}

/** Absolute upstream URL for a router-relative path. */
export function getAtfUrl(path: string): string {
  return `${getAtfBaseUrl()}${buildAtfPath(path)}`;
}

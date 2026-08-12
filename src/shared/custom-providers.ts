/**
 * Custom providers are defined by users in a human-editable file (by default
 * `providers.conf` next to `.env`) rather than in code. Each section describes
 * one upstream, which is usually another OpenAI-compatible reverse proxy.
 *
 * This module is loaded very early -- before `config.ts` finishes evaluating --
 * because model families are derived from provider ids, so it must not import
 * any other project file.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";

/** API format spoken by a custom provider's upstream. */
export type CustomProviderType = "openai" | "anthropic" | "google-ai";

export const CUSTOM_PROVIDER_TYPES: CustomProviderType[] = [
  "openai",
  "anthropic",
  "google-ai",
];

/**
 * A model the provider exposes. `real` is what the upstream calls it, `name`
 * is what this proxy advertises and accepts; they differ when the entry uses
 * `real as name` to disguise the model.
 */
export interface ProviderModel {
  real: string;
  name: string;
}

/**
 * A value that may be given inline or as a reference to an environment
 * variable, so secrets can stay out of the providers file.
 */
export type SecretSource =
  | { kind: "env"; name: string }
  | { kind: "inline"; value: string };

export interface CustomProvider {
  /** Section name. Also the local route (/proxy/<id>) and the model family. */
  id: string;
  type: CustomProviderType;
  /** Upstream base URL, without a trailing slash. */
  url: string;
  /** `v1` appends /v1 to the upstream path, `bare` does not. */
  pathStyle: "v1" | "bare";
  /** Max context tokens, used when the model name is unknown to the proxy. */
  contextLimit: number;
  /** USD per 1M tokens. */
  price: { input: number; output: number };
  /** Deepseek-style assistant prefill for deepseek-* models. */
  prefill: boolean;
  /**
   * Retry requests that the upstream rate-limited from inside an already-
   * started response stream, instead of passing its error on to the client.
   * A 429 that arrives as an HTTP status is always retried, regardless of this.
   */
  retry429: boolean;
  /**
   * Pause between those retries, in seconds. 0 paces them like the non-
   * streaming path does, i.e. by the assigned key's own rate limit lockout.
   */
  retryDelay: number;
  /** Display name on the info page. */
  label: string;
  /**
   * Models this provider exposes. When set, only these are listed by /models
   * and accepted for completions; everything else the upstream offers is
   * hidden. When unset, the upstream's own listing is passed through.
   */
  models?: ProviderModel[];
  /**
   * Set by a `*` entry in `models`: whatever else the upstream offers stays
   * visible and usable, while the declared entries still apply their aliases.
   */
  passthroughOthers: boolean;
  /** Overrides the global CHECK_KEYS for this provider. */
  checkKeys?: boolean;
  /** Where the keys come from; env vars are read lazily, after dotenv runs. */
  keys: SecretSource;
  /**
   * Outbound proxy for this provider's upstream requests, e.g.
   * `socks5://user:pass@host:1080`. Resolved lazily like `keys`.
   */
  proxy?: SecretSource;
  /** Source line of the section header, for error messages. */
  line: number;
}

const DEFAULT_FILE = "providers.conf";
const KNOWN_KEYS = [
  "type",
  "url",
  "keys",
  "proxy",
  "models",
  "path-style",
  "context",
  "price",
  "prefill",
  "label",
  "check-keys",
  "retry-429",
] as const;

export class ProvidersFileError extends Error {}

type RawEntry = { value: string; line: number };
type RawSection = { id: string; line: number; entries: Map<string, RawEntry> };

function fail(file: string, line: number, message: string): never {
  const text = `${file}:${line} — ${message}`;
  // The logger isn't available this early, and the message would otherwise be
  // buried in a stack trace.
  console.error(`\nОшибка в файле кастомных провайдеров:\n  ${text}\n`);
  throw new ProvidersFileError(text);
}

/** Suggests a known key for a likely typo, comparing without separators. */
function suggestKey(key: string): string | undefined {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  return KNOWN_KEYS.find((k) => k.replace(/-/g, "") === normalized);
}

function parseSections(text: string, file: string): RawSection[] {
  const sections: RawSection[] = [];
  const lines = text.split(/\r?\n/);
  let lastKey: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    // Strip comments, but not a '#' inside a value that was quoted.
    const raw = lines[i].replace(/\s+[#;].*$/, "").replace(/^\s*[#;].*$/, "");
    const line = raw.trim();
    if (!line) continue;

    // An indented line that isn't itself `known-key = ...` continues the
    // previous value, so long lists can be spread over several lines.
    // Note that a value may start with '[' -- model names on some upstreams
    // are prefixed like `[v]gemini-2.5-pro` -- so only a line that is entirely
    // a bracketed name counts as a section header here.
    const startsNewKey = KNOWN_KEYS.some((k) =>
      new RegExp(`^${k}\\s*=`).test(line)
    );
    const isSectionHeader = /^\[[^\[\]]*\]$/.test(line);
    if (/^\s/.test(raw) && lastKey && !isSectionHeader && !startsNewKey) {
      const current = sections[sections.length - 1];
      const entry = current?.entries.get(lastKey);
      if (entry) {
        entry.value = [entry.value, line].filter(Boolean).join(",");
        continue;
      }
    }

    const section = line.match(/^\[(.*)\]$/);
    if (section) {
      lastKey = undefined;
      const id = section[1].trim();
      if (!id) fail(file, lineNo, "пустое имя секции");
      if (sections.some((s) => s.id === id)) {
        fail(file, lineNo, `провайдер "${id}" описан повторно`);
      }
      sections.push({ id, line: lineNo, entries: new Map() });
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) {
      fail(file, lineNo, `ожидалось "ключ = значение" или "[идентификатор]"`);
    }
    const current = sections[sections.length - 1];
    if (!current) {
      fail(file, lineNo, "параметр вне секции — сначала укажите [идентификатор]");
    }

    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (current.entries.has(key)) {
      fail(file, lineNo, `параметр "${key}" указан повторно`);
    }
    current.entries.set(key, { value, line: lineNo });
    lastKey = key;
  }

  return sections;
}

function parseBoolean(file: string, key: string, entry: RawEntry): boolean {
  const v = entry.value.toLowerCase();
  if (["yes", "true", "on", "1"].includes(v)) return true;
  if (["no", "false", "off", "0"].includes(v)) return false;
  fail(file, entry.line, `${key} должно быть yes или no, получено "${entry.value}"`);
}

/** Accepts plain numbers as well as the 128k / 1m shorthand. */
function parseContext(file: string, entry: RawEntry): number {
  const match = entry.value.toLowerCase().replace(/[_\s]/g, "").match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) {
    fail(file, entry.line, `context должно быть числом, например 128k или 200000`);
  }
  const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const tokens = Math.round(parseFloat(match[1]) * scale);
  if (tokens <= 0) fail(file, entry.line, "context должно быть больше нуля");
  return tokens;
}

/**
 * What bounds the retries is the queue killing the request after five minutes
 * (see `cleanQueue` in `proxy/queue.ts`); there is no separate attempt limit.
 * A pause this long already leaves room for only a couple of attempts, so a
 * larger one is almost certainly a mistake.
 */
const MAX_RETRY_DELAY_SECONDS = 120;

/** `yes` to retry at the usual pace, or a number of seconds to pause between
 * retries. `no` and `0` disable it. */
function parseRetry(
  file: string,
  entry: RawEntry
): { retry429: boolean; retryDelay: number } {
  const value = entry.value.toLowerCase();

  if (["no", "false", "off"].includes(value)) {
    return { retry429: false, retryDelay: 0 };
  }
  if (["yes", "true", "on"].includes(value)) {
    return { retry429: true, retryDelay: 0 };
  }
  if (!/^\d+$/.test(value)) {
    fail(
      file,
      entry.line,
      `retry-429 должно быть yes, no или числом секунд, получено "${entry.value}"`
    );
  }

  const seconds = Number(value);
  if (seconds > MAX_RETRY_DELAY_SECONDS) {
    fail(
      file,
      entry.line,
      `retry-429 не может быть больше ${MAX_RETRY_DELAY_SECONDS} секунд: запрос убивается из очереди через 5 минут, и на попытки не останется времени`
    );
  }
  return { retry429: seconds > 0, retryDelay: seconds };
}

/** `0.55 / 2.19` — USD per 1M tokens, input first. */
function parsePrice(file: string, entry: RawEntry): { input: number; output: number } {
  const parts = entry.value.split("/").map((p) => p.trim());
  if (parts.length !== 2) {
    fail(file, entry.line, `price должно быть в формате "вход / выход", например 0.55 / 2.19`);
  }
  const [input, output] = parts.map((p) => Number(p));
  if (!isFinite(input) || !isFinite(output) || input < 0 || output < 0) {
    fail(file, entry.line, `price содержит недопустимое число: "${entry.value}"`);
  }
  return { input, output };
}

/** `real-model as public-name, another-model, *` */
function parseModels(
  file: string,
  entry: RawEntry
): { models: ProviderModel[]; passthroughOthers: boolean } {
  const models: ProviderModel[] = [];
  let passthroughOthers = false;

  for (const item of entry.value.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (item === "*") {
      if (passthroughOthers) {
        fail(file, entry.line, `"*" указана дважды`);
      }
      passthroughOthers = true;
      continue;
    }

    const match = item.match(/^(\S+)(?:\s+as\s+(\S+))?$/i);
    if (!match) {
      fail(
        file,
        entry.line,
        `не удалось разобрать модель "${item}"; ожидается "модель", "модель as псевдоним" или "*"`
      );
    }
    if (match[1] === "*") {
      fail(file, entry.line, `"*" нельзя переименовать`);
    }

    const model = { real: match[1], name: match[2] ?? match[1] };
    if (models.some((m) => m.name === model.name)) {
      fail(file, entry.line, `модель "${model.name}" указана дважды`);
    }
    models.push(model);
  }

  if (models.length === 0 && !passthroughOthers) {
    fail(file, entry.line, "список models пуст");
  }
  return { models, passthroughOthers };
}

const PROXY_PROTOCOLS = [
  "socks5:",
  "socks5h:",
  "socks4:",
  "socks4a:",
  "socks:",
  "http:",
  "https:",
];

/**
 * Validates an outbound proxy URL. Reported through a callback because the
 * value may come from the file (where we know the line) or from the
 * environment (where we don't).
 */
export function assertValidProxyUrl(
  value: string,
  report: (message: string) => never
): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    report(
      `proxy должен быть URL вида socks5://пользователь:пароль@хост:1080, получено "${value}"`
    );
  }
  if (!PROXY_PROTOCOLS.includes(parsed.protocol)) {
    report(
      `протокол прокси "${parsed.protocol.replace(":", "")}" не поддерживается; допустимы ${PROXY_PROTOCOLS.map((p) => p.replace(":", "")).join(", ")}`
    );
  }
  if (!parsed.hostname || !parsed.port) {
    report(`в адресе прокси "${value}" не указан хост или порт`);
  }
}

function parseUrl(file: string, entry: RawEntry): string {
  const trimmed = entry.value.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    fail(file, entry.line, `url должен быть абсолютным, например https://example.com/proxy`);
  }
  if (parsed.protocol !== "https:") {
    fail(file, entry.line, "url должен использовать https");
  }
  return trimmed;
}

function buildProvider(section: RawSection, file: string): CustomProvider {
  const { id, entries } = section;

  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
    fail(
      file,
      section.line,
      `идентификатор "${id}" недопустим: только строчные латинские буквы, цифры, "-" и "_", до 32 символов`
    );
  }

  for (const [key, entry] of entries) {
    if (!KNOWN_KEYS.includes(key as (typeof KNOWN_KEYS)[number])) {
      const hint = suggestKey(key);
      fail(
        file,
        entry.line,
        `неизвестный параметр "${key}"${hint ? ` (возможно, имелось в виду "${hint}")` : ""}`
      );
    }
  }

  const required = (key: string): RawEntry => {
    const entry = entries.get(key);
    if (!entry) fail(file, section.line, `у провайдера "${id}" не задан обязательный параметр "${key}"`);
    return entry;
  };

  const typeEntry = required("type");
  const type = typeEntry.value.toLowerCase() as CustomProviderType;
  if (!CUSTOM_PROVIDER_TYPES.includes(type)) {
    fail(
      file,
      typeEntry.line,
      `type "${typeEntry.value}" не поддерживается; доступны ${CUSTOM_PROVIDER_TYPES.join(", ")}`
    );
  }

  const toSecret = (entry: RawEntry): SecretSource => {
    if (!entry.value.startsWith("$")) return { kind: "inline", value: entry.value };
    const name = entry.value.slice(1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      fail(file, entry.line, `"${entry.value}" не похоже на имя переменной окружения`);
    }
    return { kind: "env", name };
  };

  const keys = toSecret(required("keys"));

  const proxyEntry = entries.get("proxy");
  const proxy = proxyEntry ? toSecret(proxyEntry) : undefined;
  if (proxy?.kind === "inline") {
    assertValidProxyUrl(proxy.value, (message) =>
      fail(file, proxyEntry!.line, message)
    );
  }

  const pathStyleEntry = entries.get("path-style");
  const pathStyle = pathStyleEntry?.value.toLowerCase() ?? "v1";
  if (pathStyle !== "v1" && pathStyle !== "bare") {
    fail(file, pathStyleEntry!.line, `path-style должно быть v1 или bare, получено "${pathStyleEntry!.value}"`);
  }

  const modelsEntry = entries.get("models");
  const contextEntry = entries.get("context");
  const priceEntry = entries.get("price");
  const prefillEntry = entries.get("prefill");
  const checkKeysEntry = entries.get("check-keys");
  const retryEntry = entries.get("retry-429");

  return {
    id,
    type,
    url: parseUrl(file, required("url")),
    pathStyle,
    contextLimit: contextEntry ? parseContext(file, contextEntry) : 200_000,
    price: priceEntry ? parsePrice(file, priceEntry) : { input: 0, output: 0 },
    prefill: prefillEntry ? parseBoolean(file, "prefill", prefillEntry) : false,
    ...(retryEntry
      ? parseRetry(file, retryEntry)
      : { retry429: false, retryDelay: 0 }),
    ...(modelsEntry
      ? parseModels(file, modelsEntry)
      : { models: undefined, passthroughOthers: true }),
    label: entries.get("label")?.value || id.toUpperCase(),
    checkKeys: checkKeysEntry ? parseBoolean(file, "check-keys", checkKeysEntry) : undefined,
    keys,
    proxy,
    line: section.line,
  };
}

function loadProviders(): CustomProvider[] {
  // config.ts hasn't run yet when this module is first evaluated, so .env has
  // to be loaded here too. dotenv never overwrites already-set variables.
  dotenv.config();

  const file = process.env.PROVIDERS_FILE || DEFAULT_FILE;
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) return [];

  const text = fs.readFileSync(resolved, "utf8");
  return parseSections(text, file).map((section) => buildProvider(section, file));
}

const providersFile = process.env.PROVIDERS_FILE || DEFAULT_FILE;
const providers: CustomProvider[] = loadProviders();
const byId = new Map(providers.map((p) => [p.id, p]));

/** Path of the providers file, for error messages. */
export function getProvidersFilePath(): string {
  return providersFile;
}

export function getCustomProviders(): CustomProvider[] {
  return providers;
}

export function getCustomProvider(id: string): CustomProvider | undefined {
  return byId.get(id);
}

export function isCustomProviderId(id: string): boolean {
  return byId.has(id);
}

function resolveSecret(source: SecretSource): string {
  return source.kind === "inline"
    ? source.value
    : process.env[source.name] ?? "";
}

/** Reads the provider's keys. Safe to call only after dotenv has run. */
export function resolveProviderKeys(provider: CustomProvider): string[] {
  return resolveSecret(provider.keys)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Reads the provider's outbound proxy URL, if it has one. */
export function resolveProviderProxy(
  provider: CustomProvider
): string | undefined {
  if (!provider.proxy) return undefined;
  return resolveSecret(provider.proxy).trim() || undefined;
}

/**
 * Translates a model name the client asked for into the name the upstream
 * knows. Returns undefined if the provider restricts its models and this one
 * isn't among them.
 */
export function resolveProviderModel(
  provider: CustomProvider,
  requested: string
): string | undefined {
  if (!provider.models) return requested;

  const declared = provider.models.find((m) => m.name === requested);
  if (declared) return declared.real;

  if (!provider.passthroughOthers) return undefined;

  // A disguised model's real name is not advertised, so it isn't accepted
  // either -- otherwise the disguise would be trivially bypassed.
  const isHiddenRealName = provider.models.some(
    (m) => m.real === requested && m.name !== requested
  );
  return isHiddenRealName ? undefined : requested;
}

/** Reverse of `resolveProviderModel`, for what we show back to the client. */
export function toPublicModelName(
  provider: CustomProvider,
  real: string
): string {
  return provider.models?.find((m) => m.real === real)?.name ?? real;
}

/** Names declared in the file, in order. Undefined when `models` is unset. */
export function getDeclaredModelNames(
  provider: CustomProvider
): string[] | undefined {
  return provider.models?.map((m) => m.name);
}

/**
 * Builds the advertised model list for a provider that also passes through the
 * upstream's own models: declared names first, then everything the upstream
 * offers except the real names of disguised models.
 */
export function mergeUpstreamModelNames(
  provider: CustomProvider,
  upstreamIds: string[]
): string[] {
  const declared = provider.models ?? [];
  const hidden = new Set(
    declared.filter((m) => m.name !== m.real).map((m) => m.real)
  );
  const names = declared.map((m) => m.name);

  for (const id of upstreamIds) {
    if (hidden.has(id) || names.includes(id)) continue;
    names.push(id);
  }
  return names;
}

/** Normalizes a router-relative path to the upstream's path layout. */
export function buildProviderPath(provider: CustomProvider, reqPath: string): string {
  const withoutV1 = reqPath.replace(/^\/v1(?=\/|$)/, "");
  const rest = withoutV1.startsWith("/") ? withoutV1 : `/${withoutV1}`;
  return provider.pathStyle === "bare" ? rest : `/v1${rest}`;
}

/** Absolute upstream URL for a router-relative path. */
export function getProviderUrl(provider: CustomProvider, reqPath: string): string {
  return `${provider.url}${buildProviderPath(provider, reqPath)}`;
}

import { Request, RequestHandler, Router } from "express";
import axios from "axios";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyReqMutator } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { AtfKey, keyPool } from "../shared/key-management";
import { buildAtfPath, getAtfBaseUrl, getAtfUrl } from "../shared/atf";
import { logger } from "../logger";

const log = logger.child({ module: "proxy", service: "atf" });
let modelsCache: any = null;
let modelsCacheTime = 0;

const atfResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

const getModelsResponse = async () => {
  // Return cache if less than 1 minute old
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  const url = getAtfUrl("/v1/models");
  const atfKey = keyPool.get("atf", "atf") as AtfKey;

  if (!atfKey || !atfKey.key) {
    throw new Error("Failed to get valid ATF key");
  }

  const response = await axios.get(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${atfKey.key}`,
    },
  });

  if (!response.data || !Array.isArray(response.data.data)) {
    throw new Error("Unexpected response format from ATF upstream");
  }

  // The upstream is another proxy, so its listing is already in OpenAI format;
  // only the owner is rewritten so users can tell where the models came from.
  modelsCache = {
    object: "list",
    data: response.data.data.map((model: any) => ({
      ...model,
      object: model.object ?? "model",
      owned_by: "atf",
    })),
  };
  modelsCacheTime = new Date().getTime();

  log.debug({ url, modelCount: modelsCache.data.length }, "Retrieved models from ATF upstream");
  return modelsCache;
};

const handleModelRequest: RequestHandler = async (_req, res) => {
  try {
    const modelsResponse = await getModelsResponse();
    res.status(200).json(modelsResponse);
  } catch (error) {
    if (error instanceof Error) {
      log.error(
        { errorMessage: error.message, stack: error.stack },
        "Error fetching ATF models"
      );
    } else {
      log.error({ error }, "Unknown error fetching ATF models");
    }
    res.status(500).json({ error: "Failed to fetch models" });
  }
};

/**
 * Combines all the assistant messages at the end of the context and adds the
 * Deepseek beta 'prefix' option, making prefills work the same way they work
 * for Claude. Off by default because the upstream proxy may not route the
 * request to a Deepseek beta endpoint; set ATF_PREFILL=true to enable.
 */
function enablePrefill(req: Request) {
  if (process.env.ATF_PREFILL !== "true") return;
  if (!String(req.body.model ?? "").includes("deepseek")) return;

  const msgs = req.body.messages;
  if (msgs.at(-1)?.role !== "assistant") return;

  let i = msgs.length - 1;
  let content = "";

  while (i >= 0 && msgs[i].role === "assistant") {
    content = msgs[i--].content + content;
  }

  msgs.splice(i + 1, msgs.length, { role: "assistant", content, prefix: true });
}

/** Rewrites the request path to match the configured ATF path style. */
const rewritePathForAtf: ProxyReqMutator = (manager) => {
  const req = manager.request;
  const originalPath = req.path;
  const newPath = buildAtfPath(originalPath);

  if (newPath !== originalPath) {
    manager.setPath(newPath);
    log.debug({ originalPath, newPath }, "Rewrote ATF path");
  }
};

const atfProxy = createQueuedProxyMiddleware({
  mutations: [addKey, rewritePathForAtf, finalizeBody],
  // Resolved per request so ATF_BASE_URL changes don't require a rebuild of the
  // middleware.
  target: () => getAtfBaseUrl(),
  blockingResponseHandler: atfResponseHandler,
});

const atfRouter = Router();

atfRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "atf" },
    { afterTransform: [enablePrefill] }
  ),
  atfProxy
);

atfRouter.get("/v1/models", handleModelRequest);

export const atf = atfRouter;

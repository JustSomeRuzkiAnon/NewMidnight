import { Request, RequestHandler, Router } from "express";
import axios from "axios";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyReqMutator } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { CustomKey, keyPool } from "../shared/key-management";
import {
  CustomProvider,
  buildProviderPath,
  getProviderUrl,
  getDeclaredModelNames,
  mergeUpstreamModelNames,
  resolveProviderModel,
  toPublicModelName,
} from "../shared/custom-providers";
import { BadRequestError } from "../shared/errors";
import { logger } from "../logger";

/**
 * Builds the proxy router for one provider declared in the providers file.
 * Only OpenAI-format upstreams are supported for now; the parser rejects any
 * other `type` before we get here.
 */
export function createCustomProviderRouter(provider: CustomProvider): Router {
  const log = logger.child({
    module: "proxy",
    service: "custom",
    provider: provider.id,
  });

  let modelsCache: any = null;
  let modelsCacheTime = 0;

  const responseHandler: ProxyResHandlerWithBody = async (
    _proxyRes,
    req,
    res,
    body
  ) => {
    if (typeof body !== "object") {
      throw new Error("Expected body to be an object");
    }

    // Put the advertised name back so the disguise holds in the response.
    const model = req.publicModelName ?? (body as any).model;

    res.status(200).json({ ...body, model, proxy: body.proxy });
  };

  const asModelList = (ids: string[]) => ({
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: provider.id,
    })),
  });

  const getModelsResponse = async () => {
    const declared = getDeclaredModelNames(provider);

    // A closed list is authoritative: it hides whatever else the upstream
    // offers, so there's nothing to fetch.
    if (declared && !provider.passthroughOthers) {
      return asModelList(declared);
    }

    // Return cache if less than 1 minute old
    if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
      return modelsCache;
    }

    const url = getProviderUrl(provider, "/v1/models");
    const key = keyPool.get(
      provider.id,
      "custom",
      undefined,
      undefined,
      undefined,
      provider.id
    ) as CustomKey;

    if (!key || !key.key) {
      throw new Error(`Failed to get valid ${provider.id} key`);
    }

    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key.key}`,
      },
    });

    if (!response.data || !Array.isArray(response.data.data)) {
      throw new Error(`Unexpected response format from ${provider.id} upstream`);
    }

    // With a `*` entry, declared models come first and the rest of the
    // upstream's list follows, minus the real names of disguised models.
    if (declared) {
      modelsCache = asModelList(
        mergeUpstreamModelNames(
          provider,
          response.data.data.map((model: any) => String(model.id))
        )
      );
      modelsCacheTime = new Date().getTime();
      log.debug(
        { url, modelCount: modelsCache.data.length },
        "Merged declared models with upstream listing"
      );
      return modelsCache;
    }

    // The upstream already speaks OpenAI, so only the owner is rewritten to
    // show users where the models came from.
    modelsCache = {
      object: "list",
      data: response.data.data.map((model: any) => ({
        ...model,
        object: model.object ?? "model",
        owned_by: provider.id,
      })),
    };
    modelsCacheTime = new Date().getTime();

    log.debug({ url, modelCount: modelsCache.data.length }, "Retrieved models from upstream");
    return modelsCache;
  };

  const handleModelRequest: RequestHandler = async (_req, res) => {
    try {
      res.status(200).json(await getModelsResponse());
    } catch (error) {
      if (error instanceof Error) {
        log.error(
          { errorMessage: error.message, stack: error.stack },
          "Error fetching models"
        );
      } else {
        log.error({ error }, "Unknown error fetching models");
      }
      res.status(500).json({ error: "Failed to fetch models" });
    }
  };

  /** Tags the request so key selection and stats can find the provider. */
  const setProviderId: RequestHandler = (req, _res, next) => {
    req.customProviderId = provider.id;
    next();
  };

  /**
   * Swaps the advertised model name for the one the upstream actually knows,
   * and rejects models the provider doesn't expose. The original name is kept
   * on the request so responses can be rewritten back to it.
   */
  function applyModelAlias(req: Request) {
    const requested = String(req.body.model ?? "");
    const real = resolveProviderModel(provider, requested);

    if (!real) {
      // With a `*` entry the accepted set is open-ended, so listing it would
      // be misleading.
      const available = provider.passthroughOthers
        ? ""
        : ` Available models: ${(getDeclaredModelNames(provider) ?? []).join(", ")}`;
      throw new BadRequestError(
        `Model '${requested}' is not available.${available}`
      );
    }

    req.publicModelName = requested;
    if (real !== requested) {
      req.body.model = real;
      log.debug({ requested, real }, "Substituted upstream model name");
    }
  }

  /**
   * Combines trailing assistant messages and adds the Deepseek beta 'prefix'
   * option, making prefills work the way they do for Claude. Only enabled when
   * the provider opts in, since an arbitrary upstream may reject it.
   */
  function enablePrefill(req: Request) {
    if (!provider.prefill) return;
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

  /** Rewrites the request path to match the provider's path style. */
  const rewritePath: ProxyReqMutator = (manager) => {
    const req = manager.request;
    const originalPath = req.path;
    const newPath = buildProviderPath(provider, originalPath);

    if (newPath !== originalPath) {
      manager.setPath(newPath);
      log.debug({ originalPath, newPath }, "Rewrote upstream path");
    }
  };

  const proxy = createQueuedProxyMiddleware({
    mutations: [addKey, rewritePath, finalizeBody],
    target: () => provider.url,
    blockingResponseHandler: responseHandler,
  });

  const router = Router();

  router.post(
    "/v1/chat/completions",
    ipLimiter,
    setProviderId,
    createPreprocessorMiddleware(
      { inApi: "openai", outApi: "openai", service: "custom" },
      { afterTransform: [applyModelAlias, enablePrefill] }
    ),
    proxy
  );

  router.get("/v1/models", setProviderId, handleModelRequest);

  return router;
}

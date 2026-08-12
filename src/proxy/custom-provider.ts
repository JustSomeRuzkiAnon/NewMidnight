import { Request, RequestHandler, Router } from "express";
import axios from "axios";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody, finalizeSignedRequest } from "./middleware/request";
import { ProxyReqMutator } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import {
  transformAnthropicChatResponseToOpenAI,
  transformOpenAIResponseToAnthropicChat,
} from "./anthropic";
import {
  transformGoogleAIResponse,
  transformOpenAIResponseToGoogleAI,
} from "./google-ai";
import { assertNever } from "../shared/utils";
import { APIFormat, CustomKey, keyPool } from "../shared/key-management";
import {
  CustomProvider,
  buildProviderPath,
  getProviderUrl,
  getDeclaredModelNames,
  mergeUpstreamModelNames,
  resolveProviderModel,
  resolveProviderProxy,
  toPublicModelName,
} from "../shared/custom-providers";
import { getProxyAgent } from "../shared/network";
import { BadRequestError } from "../shared/errors";
import { logger } from "../logger";

/**
 * Builds the proxy router for one provider declared in the providers file.
 * The endpoints it exposes depend on the upstream's API format:
 *
 * - openai:    POST /v1/chat/completions
 * - anthropic: POST /v1/messages, POST /v1/chat/completions (translated)
 * - google-ai: POST /{v1beta,v1alpha}/models/<model>:generateContent,
 *              POST /v1/chat/completions (translated)
 */
export function createCustomProviderRouter(provider: CustomProvider): Router {
  const log = logger.child({
    module: "proxy",
    service: "custom",
    provider: provider.id,
  });

  let modelsCache: any = null;
  let modelsCacheTime = 0;

  /** The upstream's API format, in the vocabulary the request pipeline uses. */
  const upstreamApi: APIFormat =
    provider.type === "anthropic" ? "anthropic-chat" : provider.type;
  /** False for a cross type, where client and upstream speak different APIs. */
  const isNativeUpstream = provider.clientType === provider.type;

  // All of this provider's outbound traffic goes through its proxy, if it has
  // one: the proxied completions, the model listing, and the key checker.
  const providerProxy = resolveProviderProxy(provider);
  const agent = providerProxy ? getProxyAgent(providerProxy) : undefined;

  const responseHandler: ProxyResHandlerWithBody = async (
    _proxyRes,
    req,
    res,
    body
  ) => {
    if (typeof body !== "object") {
      throw new Error("Expected body to be an object");
    }

    let newBody: any = body;
    switch (`${req.inboundApi}<-${req.outboundApi}`) {
      case "openai<-anthropic-chat":
        newBody = transformAnthropicChatResponseToOpenAI(body);
        break;
      case "openai<-google-ai":
        newBody = transformGoogleAIResponse(body, req);
        break;
      case "anthropic-chat<-openai":
        newBody = transformOpenAIResponseToAnthropicChat(body);
        break;
      case "google-ai<-openai":
        newBody = transformOpenAIResponseToGoogleAI(body);
        break;
    }

    // Put the advertised name back so the disguise holds in the response.
    // Native Gemini responses carry no model field, so nothing is added there.
    if (req.publicModelName && newBody.model !== undefined) {
      newBody = { ...newBody, model: req.publicModelName };
    }

    res.status(200).json({ ...newBody, proxy: body.proxy });
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

  /** Auth for our own calls to the upstream, in that API's usual style. */
  const upstreamAuth = (key: CustomKey) => {
    switch (provider.type) {
      case "anthropic":
        return {
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": key.key,
            "anthropic-version": "2023-06-01",
          },
        };
      case "google-ai":
        return {
          headers: { "Content-Type": "application/json" },
          params: { key: key.key },
        };
      default:
        return {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key.key}`,
          },
        };
    }
  };

  /** Reads model ids out of either an OpenAI or a native Gemini listing. */
  const extractModelIds = (data: any): string[] | undefined => {
    if (Array.isArray(data?.data)) {
      return data.data.map((model: any) => String(model.id));
    }
    if (Array.isArray(data?.models)) {
      return data.models.map((model: any) =>
        String(model.name ?? model.id).replace(/^models\//, "")
      );
    }
    return undefined;
  };

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
      ...upstreamAuth(key),
      ...(agent ? { httpAgent: agent, httpsAgent: agent, proxy: false } : {}),
    });

    const upstreamIds = extractModelIds(response.data);
    if (!upstreamIds) {
      throw new Error(`Unexpected response format from ${provider.id} upstream`);
    }

    // With a `*` entry, declared models come first and the rest of the
    // upstream's list follows, minus the real names of disguised models.
    if (declared) {
      modelsCache = asModelList(mergeUpstreamModelNames(provider, upstreamIds));
      modelsCacheTime = new Date().getTime();
      log.debug(
        { url, modelCount: modelsCache.data.length },
        "Merged declared models with upstream listing"
      );
      return modelsCache;
    }

    modelsCache = asModelList(upstreamIds);
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

  /**
   * Rewrites the request path to match the provider's path style. The endpoint
   * the client used says nothing about the upstream's, so the path comes from
   * the format the request is being sent in.
   */
  const rewritePath: ProxyReqMutator = (manager) => {
    const req = manager.request;
    const originalPath = req.path;
    const local =
      req.outboundApi === "anthropic-chat"
        ? "/v1/messages"
        : req.outboundApi === "openai"
          ? "/v1/chat/completions"
          : originalPath;
    const newPath = buildProviderPath(provider, local);

    if (newPath !== originalPath) {
      manager.setPath(newPath);
      log.debug({ originalPath, newPath }, "Rewrote upstream path");
    }
  };

  const proxy = createQueuedProxyMiddleware({
    mutations: [addKey, rewritePath, finalizeBody],
    target: () => provider.url,
    blockingResponseHandler: responseHandler,
    agent,
  });

  const router = Router();
  router.get("/v1/models", setProviderId, handleModelRequest);

  // The endpoints exposed follow the format the provider speaks to its clients;
  // what goes out to the upstream follows `upstreamApi`. They differ only for a
  // provider declared with a cross type.
  switch (provider.clientType) {
    case "openai":
      router.post(
        "/v1/chat/completions",
        ipLimiter,
        setProviderId,
        createPreprocessorMiddleware(
          { inApi: "openai", outApi: upstreamApi, service: "custom" },
          { afterTransform: [applyModelAlias, enablePrefill] }
        ),
        proxy
      );
      break;

    case "anthropic":
      // Native Anthropic messages endpoint.
      router.post(
        "/v1/messages",
        ipLimiter,
        setProviderId,
        createPreprocessorMiddleware(
          { inApi: "anthropic-chat", outApi: upstreamApi, service: "custom" },
          { afterTransform: [applyModelAlias] }
        ),
        proxy
      );
      if (isNativeUpstream) {
        // OpenAI-to-Anthropic compatibility endpoint.
        router.post(
          "/v1/chat/completions",
          ipLimiter,
          setProviderId,
          createPreprocessorMiddleware(
            { inApi: "openai", outApi: "anthropic-chat", service: "custom" },
            { afterTransform: [applyModelAlias] }
          ),
          proxy
        );
      }
      break;

    case "google-ai":
      buildGoogleAIRoutes(router);
      break;

    default:
      assertNever(provider.clientType);
  }

  return router;

  /**
   * A Gemini upstream takes the model and the API key in the URL rather than
   * the body, so it needs its own key mutator and its own target. With a cross
   * type the client still speaks Gemini but the upstream is an ordinary
   * OpenAI-compatible one, which the shared proxy already handles.
   */
  function buildGoogleAIRoutes(googleRouter: Router) {
    const base = new URL(provider.url);
    const basePath = base.pathname.replace(/\/+$/, "");

    const addGoogleKey: ProxyReqMutator = (manager) => {
      const req = manager.request;
      const key = keyPool.get(
        req.body.model,
        "custom",
        undefined,
        undefined,
        undefined,
        provider.id
      ) as CustomKey;
      manager.setKey(key);

      const apiVersion = req.params.apiVersion || "v1beta";
      const action = req.isStreaming
        ? "streamGenerateContent?alt=sse&"
        : "generateContent?";
      const payload = { ...req.body, stream: undefined, model: undefined };

      manager.setSignedRequest({
        method: "POST",
        protocol: base.protocol,
        hostname: base.host,
        path: `${basePath}/${apiVersion}/models/${req.body.model}:${action}key=${key.key}`,
        headers: { host: base.host, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      req.log.info(
        { key: key.hash, model: req.body.model, stream: req.isStreaming },
        "Assigned key to request"
      );
    };

    const googleProxy = isNativeUpstream
      ? createQueuedProxyMiddleware({
          mutations: [addGoogleKey, finalizeSignedRequest],
          target: ({ signedRequest }: any) => {
            if (!signedRequest)
              throw new Error("Must sign request before proxying");
            return `${signedRequest.protocol}//${signedRequest.hostname}`;
          },
          blockingResponseHandler: responseHandler,
          agent,
        })
      : proxy;

    /** The native endpoint carries the model in the URL, not the body. */
    function readModelFromUrl(req: Request) {
      const model =
        req.body.model || req.url.split("/").pop()?.split(":").shift();
      if (!model) {
        throw new BadRequestError("You must specify a model with your request.");
      }
      req.body.model = model.replace(/^models\//, "");
    }

    function setStreamFlag(req: Request) {
      const isStreaming = req.url.includes("streamGenerateContent");
      req.body.stream = isStreaming;
      req.isStreaming = isStreaming;
    }

    /** Gemini's own listing format, which some clients expect. */
    const handleNativeModelRequest: RequestHandler = async (_req, res) => {
      try {
        const models = await getModelsResponse();
        res.status(200).json({
          models: (models.data ?? []).map((model: any) => ({
            name: `models/${model.id}`,
            supportedGenerationMethods: [
              "generateContent",
              "streamGenerateContent",
            ],
          })),
        });
      } catch (error) {
        log.error({ error }, "Error fetching models");
        res.status(500).json({ error: "Failed to fetch models" });
      }
    };

    googleRouter.get(
      "/:apiVersion(v1alpha|v1beta)/models",
      setProviderId,
      handleNativeModelRequest
    );

    googleRouter.post(
      "/:apiVersion(v1alpha|v1beta)/models/:modelId:(generateContent|streamGenerateContent)",
      ipLimiter,
      setProviderId,
      createPreprocessorMiddleware(
        { inApi: "google-ai", outApi: upstreamApi, service: "custom" },
        {
          beforeTransform: [readModelFromUrl],
          afterTransform: [applyModelAlias, setStreamFlag],
        }
      ),
      googleProxy
    );

    if (!isNativeUpstream) return;

    googleRouter.post(
      "/v1/chat/completions",
      ipLimiter,
      setProviderId,
      createPreprocessorMiddleware(
        { inApi: "openai", outApi: "google-ai", service: "custom" },
        { afterTransform: [applyModelAlias] }
      ),
      googleProxy
    );
  }
}

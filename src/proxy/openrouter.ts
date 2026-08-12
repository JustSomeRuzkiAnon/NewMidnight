import { Request, RequestHandler, Router, Response, NextFunction } from "express";
import { config } from "../config";
import { ipLimiter } from "./rate-limit";
import { createPreprocessorMiddleware, finalizeSignedRequest } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { addOpenRouterKey } from "./middleware/request/mutators/add-openrouter-key";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { generateWhitelist } from "../shared/key-management/openrouter/whitelist-generator";
import { resolveModel } from "../shared/key-management/openrouter/model-resolver";
import { transformOpenAIResponseToAnthropicChat } from "./anthropic";
import { transformOpenAIResponseToGoogleAI } from "./google-ai";
import axios from "axios";

let modelsCache: any = null;
let modelsCacheTime = 0;
let whitelistCache: any = null;

const refreshModels = async () => {
  if (new Date().getTime() - modelsCacheTime < 3600000 && modelsCache) return modelsCache;
  try {
    const { data } = await axios.get("https://openrouter.ai/api/v1/models");
    whitelistCache = generateWhitelist(data);
    modelsCache = data;
    modelsCacheTime = Date.now();
    return modelsCache;
  } catch (e) { return modelsCache || { data: [] }; }
};
refreshModels();

const handleModelRequest: RequestHandler = async (_req, res) => {
  const data = await refreshModels();
  res.status(200).json(data);
};

// Это обычная миддлвара Express, она остается как есть (req, res, next)
const consolidateModelFromParams = (req: Request, res: Response, next: NextFunction) => {
  if (req.params.modelId && !req.body.model) req.body.model = req.params.modelId.replace(/^models\//, "");
  next();
};

const resolveOpenRouterModel = async (req: Request) => {
  if (!whitelistCache) await refreshModels();
  const userModel = req.body.model;
  const conf = { allowPaid: config.allowPaidOpenRouter ?? true, allowModerated: config.allowModeratedOpenRouter ?? false };
  
  const [modelData, error] = resolveModel(userModel, whitelistCache, conf);

  if (error) {
    const err: any = new Error(`Model resolution failed: ${error}`);
    err.statusCode = 400;
    throw err;
  }

  if ((req.promptTokens || 0) > modelData!.context) {
    const err: any = new Error(`Context limit exceeded. Model supports ${modelData!.context}, request has ${req.promptTokens}.`);
    err.statusCode = 400;
    throw err;
  }

  req.body.model = modelData!.id;
};

const openRouterBlockingResponseHandler: ProxyResHandlerWithBody = async (_p, req, res, body) => {
  let responseBody = body;

  if (req.inboundApi === "google-ai") {
    responseBody = transformOpenAIResponseToGoogleAI(body as Record<string, any>);
  }

  if (req.inboundApi === "anthropic-chat") {
    responseBody = transformOpenAIResponseToAnthropicChat(
      body as Record<string, any>
    );
  }

  res.status(200).json(responseBody);
};


const openRouterProxy = createQueuedProxyMiddleware({
  target: ({ signedRequest }) => { if (!signedRequest) throw new Error("Unsigned"); return "https://openrouter.ai"; },
  mutations: [addOpenRouterKey, finalizeSignedRequest],
  blockingResponseHandler: openRouterBlockingResponseHandler,
});

const OpenRouterRouter = Router();

OpenRouterRouter.get("/v1/models", handleModelRequest);

OpenRouterRouter.post(
  "/v1/chat/completions", 
  ipLimiter, 
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "openrouter" }, 
    { afterTransform: [resolveOpenRouterModel] }
  ), 
  openRouterProxy
);

OpenRouterRouter.post(
  "/v1/messages", 
  ipLimiter, 
  createPreprocessorMiddleware(
    { inApi: "anthropic-chat", outApi: "openai", service: "openrouter" }, 
    { afterTransform: [resolveOpenRouterModel] }
  ), 
  openRouterProxy
);

OpenRouterRouter.post(
  "/:apiVersion(v1alpha|v1beta)/models/:modelId:(generateContent|streamGenerateContent)", 
  ipLimiter, 
  consolidateModelFromParams,
  createPreprocessorMiddleware(
    { inApi: "google-ai", outApi: "openai", service: "openrouter" }, 
    { afterTransform: [resolveOpenRouterModel] }
  ), 
  openRouterProxy
);

export const openRouter = OpenRouterRouter;
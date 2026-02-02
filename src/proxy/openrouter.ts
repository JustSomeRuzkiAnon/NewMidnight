import { Request, RequestHandler, Router, Response, NextFunction } from "express";
import { config } from "../config";
import { ipLimiter } from "./rate-limit";
import { createPreprocessorMiddleware, finalizeSignedRequest } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { addOpenRouterKey } from "./middleware/request/mutators/add-openrouter-key";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { generateWhitelist } from "../shared/key-management/openrouter/whitelist-generator";
import { resolveModel } from "../shared/key-management/openrouter/model-resolver";
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

// Хелпер для конвертации ответа OpenAI -> Google
function transformOpenAIToGoogleResponse(openaiBody: any) {
  const choice = openaiBody.choices?.[0];
  if (!choice) return { candidates: [] };

  const parts: any[] = [];

  const reasoning = choice.message.reasoning || choice.message.reasoning_content;
  
  if (reasoning) {
    parts.push({ text: reasoning, thought: true });
  }

  parts.push({ text: choice.message?.content || "" });

  return {
    candidates: [
      {
        content: {
          parts: parts,
          role: "model"
        },
        finishReason: (choice.finish_reason || "STOP").toUpperCase(),
        index: 0,
        safetyRatings: []
      }
    ],
    usageMetadata: {
      promptTokenCount: openaiBody.usage?.prompt_tokens || 0,
      candidatesTokenCount: openaiBody.usage?.completion_tokens || 0,
      totalTokenCount: openaiBody.usage?.total_tokens || 0
    }
  };
}

// Хелпер для конвертации ответа OpenAI -> Anthropic
function transformOpenAIToAnthropicResponse(openaiBody: any) {
  const choice = openaiBody.choices?.[0];
  if (!choice) {
    // Возвращаем пустой ответ или ошибку, если пусто
    return {
      id: openaiBody.id || "error",
      type: "message",
      role: "assistant",
      content: [],
      model: openaiBody.model,
      stop_reason: "error",
      usage: { input_tokens: 0, output_tokens: 0 }
    };
  }

  const content: any[] = [];

  // 1. Проверяем наличие "мыслей" (Reasoning)
  // OpenRouter может возвращать это в reasoning (стандарт OpenAI o1) или reasoning_content (DeepSeek)
  const reasoning = choice.message.reasoning || choice.message.reasoning_content;

  if (reasoning) {
    content.push({
      type: "thinking",
      thinking: reasoning,
      signature: "openrouter-reasoning-signature" 
    });
  }

  // 2. Основной текст
  content.push({
    type: "text",
    text: choice.message.content || ""
  });

  // Маппинг причин остановки
  let stopReason = "end_turn";
  if (choice.finish_reason === "length") stopReason = "max_tokens";
  if (choice.finish_reason === "stop") stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";

  return {
    id: openaiBody.id,
    type: "message",
    role: "assistant",
    content: content,
    model: openaiBody.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiBody.usage?.prompt_tokens || 0,
      output_tokens: openaiBody.usage?.completion_tokens || 0,
      // Anthropic разделяет токены на создание и чтение кеша, но у нас этого нет
    }
  };
}


const openRouterBlockingResponseHandler: ProxyResHandlerWithBody = async (_p, req, res, body) => {
  let responseBody = body;

  if (req.inboundApi === "google-ai") {
    responseBody = transformOpenAIToGoogleResponse(body);
  }

  if (req.inboundApi === "anthropic-chat") {
    responseBody = transformOpenAIToAnthropicResponse(body);
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
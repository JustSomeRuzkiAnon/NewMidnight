import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { ProxyReqMutator } from "./middleware/request";
import axios from "axios";
import { GlmZaiKey, keyPool } from "../shared/key-management";
import { isGlmModel, isGlmThinkingModel, isGlmVisionModel } from "../shared/api-schemas/glm";
import { logger } from "../logger";

const log = logger.child({ module: "proxy", service: "glm-zai" });
let modelsCache: any = null;
let modelsCacheTime = 0;

const glmZaiResponseHandler: ProxyResHandlerWithBody = async (
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
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  try {
    const modelToUse = "glm-4.5";
    const glmZaiKey = keyPool.get(modelToUse, "glm-zai") as GlmZaiKey;

    if (!glmZaiKey || !glmZaiKey.key) {
      log.warn("No valid GLM-ZAI key available for model listing");
      throw new Error("No valid GLM-ZAI API key available");
    }

    const response = await axios.get("https://api.z.ai/api/paas/v4/models", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${glmZaiKey.key}`
      },
    });

    if (!response.data || !response.data.data) {
      throw new Error("Unexpected response format from GLM-ZAI API");
    }

    const models = response.data;

    const knownGlmModels = [
      "glm-4.5",
      "glm-4.5-air",
      "glm-4.5-x",
      "glm-4.5-airx",
      "glm-4.5-flash",
      "glm-4-plus",
      "glm-4-air-250414",
      "glm-4-airx",
      "glm-4-flashx",
      "glm-4-flashx-250414",
      "glm-z1-air",
      "glm-z1-airx",
      "glm-z1-flash",
      "glm-z1-flashx",
      "glm-4v",
    ];

    if (models.data && Array.isArray(models.data)) {
      const existingModelIds = new Set(models.data.map((model: any) => model.id));

      knownGlmModels.forEach(modelId => {
        if (!existingModelIds.has(modelId)) {
          models.data.push({
            id: modelId,
            object: "model",
            created: Date.now(),
            owned_by: "glm-zai",
          });
        }
      });
    } else {
      models.data = knownGlmModels.map(modelId => ({
        id: modelId,
        object: "model",
        created: Date.now(),
        owned_by: "glm-zai",
      }));
    }

    log.debug({ modelCount: models.data?.length }, "Retrieved models from GLM-ZAI API");

    modelsCache = models;
    modelsCacheTime = new Date().getTime();
    return models;
  } catch (error) {
    if (error instanceof Error) {
      log.error(
        { errorMessage: error.message, stack: error.stack },
        "Error fetching GLM-ZAI models"
      );
    } else {
      log.error({ error }, "Unknown error fetching GLM-ZAI models");
    }

    return {
      object: "list",
      data: [],
    };
  }
};

const handleModelRequest: RequestHandler = async (_req, res) => {
  try {
    const models = await getModelsResponse();
    res.status(200).json(models);
  } catch (error) {
    if (error instanceof Error) {
      log.error(
        { errorMessage: error.message, stack: error.stack },
        "Error handling model request"
      );
    } else {
      log.error({ error }, "Unknown error handling model request");
    }
    res.status(500).json({ error: "Failed to fetch models" });
  }
};

function processGlmZaiRequest(req: Request) {
  const model = req.body.model;

  if (!isGlmModel(model)) {
    log.warn({ model }, "Non-GLM model passed to GLM-ZAI processor");
    return;
  }

  if (req.body.thinking && typeof req.body.thinking === "object") {
    if (isGlmThinkingModel(model)) {
      log.debug({ model, thinking: req.body.thinking }, "GLM-ZAI thinking mode enabled");
    } else {
      delete req.body.thinking;
      log.debug({ model }, "Removed thinking parameter for non-thinking model");
    }
  }

  if (req.body.tools && req.body.tools.length > 0) {
    log.debug({ model, toolCount: req.body.tools.length }, "GLM-ZAI function calling enabled");
  }

  if (isGlmVisionModel(model) && req.body.messages) {
    const hasImages = req.body.messages.some((msg: any) =>
      msg.content && Array.isArray(msg.content) &&
      msg.content.some((content: any) => content.type === "image_url")
    );
    if (hasImages) {
      log.debug({ model }, "GLM-ZAI vision model request detected");
    }
  }

  if (req.body.logit_bias !== undefined) {
    delete req.body.logit_bias;
    log.debug({ model }, "Removed unsupported logit_bias parameter");
  }

  if (req.body.temperature !== undefined) {
    if (req.body.temperature < 0 || req.body.temperature > 1) {
      req.body.temperature = Math.max(0, Math.min(1, req.body.temperature));
      log.debug({ model }, "Clamped temperature to valid range [0,1]");
    }
  }

  if (req.body.top_p !== undefined) {
    if (req.body.top_p < 0 || req.body.top_p > 1) {
      req.body.top_p = Math.max(0, Math.min(1, req.body.top_p));
      log.debug({ model }, "Clamped top_p to valid range [0,1]");
    }
  }
}

const rewritePathForGlmZai: ProxyReqMutator = (manager) => {
  const req = manager.request;
  let newPath = req.path;

  log.debug({ currentPath: req.path, currentUrl: req.url }, "GLM-ZAI path before rewrite");

  if (req.path === "/chat/completions") {
    newPath = "/v4/chat/completions";
  } else if (req.path === "/models") {
    newPath = "/v4/models";
  } else if (req.path.startsWith("/v1/")) {
    newPath = req.path.replace("/v1/", "/v4/");
  } else if (!req.path.startsWith("/v4/")) {
    newPath = `/v4${req.path}`;
  }

  if (newPath !== req.path) {
    manager.setPath(newPath);
    log.debug({ originalPath: req.path, newPath }, "Rewrote GLM-ZAI path for v4 API");
  }
};

const glmZaiProxy = createQueuedProxyMiddleware({
  mutations: [addKey, rewritePathForGlmZai, finalizeBody],
  target: "https://api.z.ai/api/paas",
  blockingResponseHandler: glmZaiResponseHandler,
});

const glmZaiRouter = Router();

glmZaiRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "glm-zai" },
    { afterTransform: [processGlmZaiRequest] }
  ),
  glmZaiProxy
);

glmZaiRouter.post(
  "/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "glm-zai" },
    { afterTransform: [processGlmZaiRequest] }
  ),
  glmZaiProxy
);

glmZaiRouter.get("/v1/models", handleModelRequest);
glmZaiRouter.get("/models", handleModelRequest);

export const glmZai = glmZaiRouter;

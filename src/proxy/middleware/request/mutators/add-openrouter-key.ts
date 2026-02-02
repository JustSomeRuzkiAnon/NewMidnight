import { keyPool, OpenRouterKey } from "../../../../shared/key-management";
import { ProxyReqMutator } from "../index";

const OPENROUTER_HEADERS = {
  'HTTP-Referer': 'https://blackbox.ai',
  'X-Title': 'BLACKBOXAI',
};

export const addOpenRouterKey: ProxyReqMutator = (manager) => {
  const req = manager.request;
  if (req.service !== "openrouter") throw new Error("Invalid service");

  const key = keyPool.get(req.body.model, "openrouter", undefined, undefined, req) as OpenRouterKey;
  manager.setKey(key);

  req.log.info({ key: key.hash, model: req.body.model }, "Assigned OpenRouter key");

  manager.setHeader("Authorization", `Bearer ${key.key}`);
  Object.entries(OPENROUTER_HEADERS).forEach(([h, v]) => manager.setHeader(h, v));

  manager.setSignedRequest({
    method: "POST",
    protocol: "https:",
    hostname: "openrouter.ai",
    path: "/api/v1/chat/completions",
    headers: { ["host"]: "openrouter.ai", ["content-type"]: "application/json" },
    body: JSON.stringify(req.body),
  });
};
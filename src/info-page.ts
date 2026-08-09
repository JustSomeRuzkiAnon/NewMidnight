/*  ──────────────────────────────────────────────────────────────
    Login-gated info page - BEAUTIFIED VERSION
    drop-in replacement for src/info-page.ts
    ──────────────────────────────────────────────────────────── */

import fs from "fs";
import express, { Router, Request, Response } from "express";
import showdown from "showdown";
import { config } from "./config";
import { buildInfo, ServiceInfo } from "./service-info";
import { getLastNImages } from "./shared/file-storage/image-history";
import { keyPool } from "./shared/key-management";
import { getServiceForFamily, ModelFamily } from "./shared/models";
import { getCustomProvider } from "./shared/custom-providers";
import { withSession } from "./shared/with-session";
import { injectCsrfToken, checkCsrfToken } from "./shared/inject-csrf";
import { getUser } from "./shared/users/user-store";

/* ────────────────  TYPES: extend express-session  ──────────── */
declare module "express-session" {
  interface Session {
    infoPageAuthed?: boolean;
  }
}

/* ────────────────  misc constants  ─────────────────────────── */
const INFO_PAGE_TTL = 2_000; // ms
const LOGIN_ROUTE   = "/";

const MODEL_FAMILY_FRIENDLY_NAME: { [f in ModelFamily]: string } = {
  qwen: "Qwen",
  glm: "GLM",
  "glm-zai": "GLM-ZAI",
  "glm-zai-coding": "GLM-ZAI-CODING",
  cohere: "Cohere",
  atf: "ATF",
  deepseek: "Deepseek",
  xai: "Grok",
  moonshot: "Moonshot",
  turbo: "GPT-4o Mini / 3.5 Turbo",
  gpt4: "GPT-4",
  "gpt4-32k": "GPT-4 32k",
  "gpt4-turbo": "GPT-4 Turbo",
  gpt4o: "GPT-4o",
  gpt41: "GPT-4.1",
  "gpt41-mini": "GPT-4.1 Mini",
  "gpt41-nano": "GPT-4.1 Nano",
  gpt5: "GPT-5",
  "gpt5-mini": "GPT-5 Mini",
  "gpt5-nano": "GPT-5 Nano",
  "gpt5-pro": "GPT-5 Pro",
  "gpt5-chat-latest": "GPT-5 Chat Latest",
  gpt45: "GPT-4.5",
  o1: "OpenAI o1",
  "o1-mini": "OpenAI o1 mini",
  "o1-pro": "OpenAI o1 pro",
  "o3-pro": "OpenAI o3 pro",
  "o3-mini": "OpenAI o3 mini",
  "o3": "OpenAI o3",
  "o4-mini": "OpenAI o4 mini",
  "codex-mini": "OpenAI Codex Mini",
  "dall-e": "DALL-E",
  "gpt-image": "GPT Image",
  claude: "Claude (Sonnet)",
  "claude-opus": "Claude (Opus)",
  "gemini-flash": "Gemini Flash",
  "gemini-pro": "Gemini Pro",
  "gemini-ultra": "Gemini Ultra",
  "gemini-images": "Gemini Image LLMs",
  "pro-preview": "Gemini Pro Preview",
  "flash-preview": "Gemini Flash Preview",
  "mistral-tiny": "Mistral 7B",
  "mistral-small": "Mistral Nemo",
  "mistral-medium": "Mistral Medium",
  "mistral-large": "Mistral Large",
  "aws-claude": "AWS Claude (Sonnet)",
  "aws-claude-opus": "AWS Claude (Opus)",
  "aws-mistral-tiny": "AWS Mistral 7B",
  "aws-mistral-small": "AWS Mistral Nemo",
  "aws-mistral-medium": "AWS Mistral Medium",
  "aws-mistral-large": "AWS Mistral Large",
  "gcp-claude": "GCP Claude (Sonnet)",
  "gcp-claude-opus": "GCP Claude (Opus)",
  "azure-turbo": "Azure GPT-3.5 Turbo",
  "azure-gpt4": "Azure GPT-4",
  "azure-gpt4-32k": "Azure GPT-4 32k",
  "azure-gpt4-turbo": "Azure GPT-4 Turbo",
  "azure-gpt4o": "Azure GPT-4o",
  "azure-gpt45": "Azure GPT-4.5",
  "azure-gpt41": "Azure GPT-4.1",
  "azure-gpt41-mini": "Azure GPT-4.1 Mini",
  "azure-gpt41-nano": "Azure GPT-4.1 Nano",
  "azure-gpt5": "Azure GPT-5",
  "azure-gpt5-mini": "Azure GPT-5 Mini",
  "azure-gpt5-nano": "Azure GPT-5 Nano",
  "azure-gpt5-pro": "GPT-5 Pro (Azure)",
  "azure-gpt5-chat-latest": "Azure GPT-5 Chat Latest",
  "azure-o1": "Azure o1",
  "azure-o1-mini": "Azure o1 mini",
  "azure-o1-pro": "Azure o1 pro",
  "azure-o3-pro": "Azure o3 pro",
  "azure-o3-mini": "Azure o3 mini",
  "azure-o3": "Azure o3",
  "azure-o4-mini": "Azure o4 mini",
  "azure-codex-mini": "Azure Codex Mini",
  "azure-dall-e": "Azure DALL-E",
  "azure-gpt-image": "Azure GPT Image",
  "openrouter": "OpenRouter",
  "OpRout_OpenAI": "OpenRouter (OpenAI)",
  "OpRout_Anthropic": "OpenRouter (Anthropic)",
  "OpRout_Google_AI_Studio": "OpenRouter (Google)",
  "OpRout_XAI": "OpenRouter (xAI)",
  "OpRout_Amazon": "OpenRouter (Amazon)",
  "OpRout_Cohere": "OpenRouter (Cohere)",
  "OpRout_Deepseek": "OpenRouter (DeepSeek)",
  "OpRout_Meta": "OpenRouter (Meta)",
  "OpRout_Mistral": "OpenRouter (Mistral)",
  "OpRout_Qwen": "OpenRouter (Qwen)",
  "OpRout_ZAI": "OpenRouter (Z.AI)",
  "OpRout_Nvidia": "OpenRouter (Nvidia)",
  "OpRout_MoonshotAI": "OpenRouter (Moonshot)",
  "OpRout_Other": "OpenRouter (Other)",
};

function getFriendlyModelFamilyName(family: ModelFamily): string {
  return (
    getCustomProvider(family)?.label ??
    MODEL_FAMILY_FRIENDLY_NAME[family] ??
    family
  );
}

const converter = new showdown.Converter();

const customGreeting = fs.existsSync("greeting.md")
  ? `<div id="servergreeting">${converter.makeHtml(fs.readFileSync("greeting.md", "utf8"))}</div>`
  : "";

/* ────────────────  SHARED CSS COMPONENTS  ──────────────────── */

const starryBackgroundCss = `
html, body { margin: 0; padding: 0; min-height: 100vh; }
body {
  color: #e0e0e0;
  background-color: #090a0f;
}

.bg-gradient {
  position: fixed;
  top: 0; left: 0; width: 100%; height: 100%;
  background: radial-gradient(ellipse at bottom, #1b2735 0%, #090a0f 100%);
  z-index: -2;
}

.stars, .twinkling-1, .twinkling-2, .meteor-container {
  position: fixed;
  top: 0; left: 0; width: 100%; height: 100%;
  z-index: -1;
  pointer-events: none;
}

/* Статичные мелкие звезды - удвоенная плотность на 600x600 */
.stars {
  background-image: 
    radial-gradient(1px 1px at 45px 65px, white, transparent),
    radial-gradient(1px 1px at 150px 125px, white, transparent),
    radial-gradient(1.5px 1.5px at 250px 40px, white, transparent),
    radial-gradient(1px 1px at 380px 90px, white, transparent),
    radial-gradient(2px 2px at 520px 50px, white, transparent),
    radial-gradient(1px 1px at 80px 250px, white, transparent),
    radial-gradient(1.5px 1.5px at 190px 320px, white, transparent),
    radial-gradient(1px 1px at 320px 200px, white, transparent),
    radial-gradient(1px 1px at 450px 280px, white, transparent),
    radial-gradient(2px 2px at 580px 350px, white, transparent),
    radial-gradient(1px 1px at 50px 450px, white, transparent),
    radial-gradient(1px 1px at 170px 520px, white, transparent),
    radial-gradient(1.5px 1.5px at 290px 480px, white, transparent),
    radial-gradient(1px 1px at 410px 550px, white, transparent),
    radial-gradient(1px 1px at 540px 460px, white, transparent),
    radial-gradient(1.5px 1.5px at 350px 380px, white, transparent),
    radial-gradient(1px 1px at 120px 580px, white, transparent),
    radial-gradient(2px 2px at 480px 150px, white, transparent),
    radial-gradient(1px 1px at 100px 80px, white, transparent),
    radial-gradient(1.5px 1.5px at 220px 180px, white, transparent),
    radial-gradient(1px 1px at 400px 20px, white, transparent),
    radial-gradient(1px 1px at 550px 180px, white, transparent),
    radial-gradient(1px 1px at 20px 300px, white, transparent),
    radial-gradient(2px 2px at 120px 400px, white, transparent),
    radial-gradient(1px 1px at 250px 270px, white, transparent),
    radial-gradient(1px 1px at 400px 350px, white, transparent),
    radial-gradient(1.5px 1.5px at 500px 250px, white, transparent),
    radial-gradient(1px 1px at 300px 100px, white, transparent),
    radial-gradient(1px 1px at 550px 550px, white, transparent),
    radial-gradient(1px 1px at 200px 60px, white, transparent),
    radial-gradient(1.5px 1.5px at 350px 500px, white, transparent),
    radial-gradient(1px 1px at 80px 500px, white, transparent),
    radial-gradient(1px 1px at 480px 400px, white, transparent);
  background-size: 600px 600px;
}

/* Мерцающие крестики - группа 1 (700x700) */
.twinkling-1 {
  background-image: 
    radial-gradient(1.5px 12px at 130px 130px, white, transparent),
    radial-gradient(12px 1.5px at 130px 130px, white, transparent),
    radial-gradient(1px 10px at 420px 380px, rgba(255,255,255,0.8), transparent),
    radial-gradient(10px 1px at 420px 380px, rgba(255,255,255,0.8), transparent),
    radial-gradient(1.5px 14px at 600px 150px, rgba(255,255,255,0.9), transparent),
    radial-gradient(14px 1.5px at 600px 150px, rgba(255,255,255,0.9), transparent),
    radial-gradient(1px 10px at 250px 580px, rgba(255,255,255,0.8), transparent),
    radial-gradient(10px 1px at 250px 580px, rgba(255,255,255,0.8), transparent);
  background-size: 700px 700px;
  animation: blink 4.5s infinite ease-in-out;
}

/* Мерцающие крестики - группа 2 (800x800) */
.twinkling-2 {
  background-image: 
    radial-gradient(2px 15px at 250px 200px, white, transparent),
    radial-gradient(15px 2px at 250px 200px, white, transparent),
    radial-gradient(1.5px 12px at 580px 480px, rgba(255,255,255,0.9), transparent),
    radial-gradient(12px 1.5px at 580px 480px, rgba(255,255,255,0.9), transparent),
    radial-gradient(1px 10px at 100px 650px, rgba(255,255,255,0.7), transparent),
    radial-gradient(10px 1px at 100px 650px, rgba(255,255,255,0.7), transparent),
    radial-gradient(2px 14px at 700px 100px, rgba(255,255,255,0.8), transparent),
    radial-gradient(14px 2px at 700px 100px, rgba(255,255,255,0.8), transparent);
  background-size: 800px 800px;
  animation: blink 6s infinite ease-in-out;
  animation-delay: 2s;
}

@keyframes blink {
  0% { opacity: 0; }
  50% { opacity: 1; }
  100% { opacity: 0; }
}

/* Падающие звезды (Метеоры) */
.meteor-container { overflow: hidden; }
.meteor {
  position: absolute;
  width: 150px;
  height: 2px;
  background: linear-gradient(to right, rgba(255, 255, 255, 1), transparent);
  transform: rotate(-45deg);
  opacity: 0;
  animation: meteor-fall linear infinite;
}
.meteor::before {
  content: '';
  position: absolute;
  width: 4px; height: 4px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 10px 2px #fff;
  left: 0; top: -1px;
}
.m1 { top: -20%; left: 80%; animation-duration: 6s; animation-delay: 1s; }
.m2 { top: 10%; left: 110%; animation-duration: 8s; animation-delay: 4s; }
.m3 { top: -10%; left: 40%; animation-duration: 10s; animation-delay: 7s; }

@keyframes meteor-fall {
  0% { opacity: 0; transform: translate(0, 0) rotate(-45deg); }
  5% { opacity: 1; }
  15% { opacity: 0; transform: translate(-600px, 600px) rotate(-45deg); }
  100% { opacity: 0; }
}

.glass-panel {
  background: rgba(255, 255, 255, 0.03);
  border-radius: 16px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
}
`;

const backgroundHtml = `
  <div class="bg-gradient"></div>
  <div class="stars"></div>
  <div class="twinkling-1"></div>
  <div class="twinkling-2"></div>
  <div class="meteor-container">
    <div class="meteor m1"></div>
    <div class="meteor m2"></div>
    <div class="meteor m3"></div>
  </div>
`;

/* ────────────────  Login page  ──────────────────────── */
function renderLoginPage(csrf: string, error?: string) {
  const errBlock = error
    ? `<div class="error-message">${escapeHtml(error)}</div>`
    : "";
  const pageTitle = getServerTitle();
  return `<!DOCTYPE html>
<html>
<head>
  <title>${pageTitle} – Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    ${starryBackgroundCss}
    body {
      font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .login-container {
      padding: 40px;
      width: 100%;
      max-width: 400px;
      text-align: center;
      box-sizing: border-box;
    }
    .logo-image { max-width: 100%; height: auto; max-height: 100px; margin-bottom: 30px; }
    h1 { font-size: 1.5rem; margin-top: 0; margin-bottom: 30px; font-weight: 300; letter-spacing: 1px;}
    .form-group { margin-bottom: 25px; text-align: left; }
    input[type=text], input[type=password] {
      width: 100%;
      padding: 12px 15px;
      margin-top: 8px;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      box-sizing: border-box;
      font-size: 16px;
      color: #fff;
      transition: all 0.2s;
    }
    input[type=text]:focus, input[type=password]:focus {
      outline: none;
      border-color: #007bff;
      background: rgba(255,255,255,0.15);
      box-shadow: 0 0 0 3px rgba(0,123,255,0.25);
    }
    input[type=text]::placeholder, input[type=password]::placeholder { color: rgba(255,255,255,0.5); }
    
    button {
      background: #007bff;
      color: #fff;
      border: none;
      padding: 12px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
      font-weight: 600;
      width: 100%;
      transition: background 0.2s, transform 0.1s;
      letter-spacing: 0.5px;
    }
    button:hover { background: #0069d9; }
    button:active { transform: translateY(1px); }
    
    .error-message {
      background: rgba(244, 67, 54, 0.2);
      border: 1px solid #f44336;
      color: #ff8a80;
      padding: 10px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
    }
    label { font-size: 14px; color: rgba(255,255,255,0.7); }
  </style>
</head>
<body>
  ${backgroundHtml}
  <div class="login-container glass-panel">
    ${config.loginImageUrl ? `<img src="${config.loginImageUrl}" alt="Logo" class="logo-image">` : `<h1>${escapeHtml(pageTitle)}</h1>`}
    ${errBlock}
    <form method="POST" action="${LOGIN_ROUTE}">
      <div class="form-group">
        ${config.serviceInfoAuthMode === "password"
          ? `<label for="password">Service Password</label><input type="password" id="password" name="password" required placeholder="••••••••">`
          : `<label for="token">User Token</label><input type="text" id="token" name="token" required placeholder="your-unique-token">`}
        <input type="hidden" name="_csrf" value="${csrf}">
      </div>
      <button type="submit">Access Dashboard</button>
    </form>
  </div>
</body>
</html>`;
}

/* ────────────────  login-required middleware  ──────────────── */
function requireLogin(
  req: Request,
  res: Response,
  next: express.NextFunction
) {
  if (req.session?.infoPageAuthed) return next();
  return res.send(renderLoginPage(res.locals.csrfToken));
}

/* ────────────────  INFO PAGE CACHING  ──────────────────────── */
let infoPageHtml: string | undefined;
let infoPageLastUpdated = 0;

export function handleInfoPage(req: Request, res: Response) {
  if (infoPageLastUpdated + INFO_PAGE_TTL > Date.now()) {
    return res.send(infoPageHtml);
  }

  const baseUrl =
    process.env.SPACE_ID && !req.get("host")?.includes("hf.space")
      ? getExternalUrlForHuggingfaceSpaceId(process.env.SPACE_ID)
      : req.protocol + "://" + req.get("host");

  const info = buildInfo(baseUrl + config.proxyEndpointRoute);
  infoPageHtml = renderPage(info);
  infoPageLastUpdated = Date.now();

  res.send(infoPageHtml);
}

/* ────────────────  RENDER FULL INFO PAGE  ──────────────────── */
export function renderPage(info: ServiceInfo) {
  const title = getServerTitle();
  const headerHtml = buildInfoPageHeader(info);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="robots" content="noindex" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    ${starryBackgroundCss}
    body {
      font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      justify-content: center;
      box-sizing: border-box;
      line-height: 1.6;
      padding: 20px;
    }

    .main-container {
      width: 100%;
      max-width: 1000px;
      padding: 40px;
      box-sizing: border-box;
      margin-top: 20px;
      margin-bottom: 40px;
      align-self: flex-start;
    }

    h1, h2, h3 { font-weight: 300; letter-spacing: 1px; color: #fff; }
    h1 { font-size: 2.5rem; margin-top: 0; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 15px; }
    h2 { font-size: 1.8rem; margin-top: 1.5em; color: #a2cfff; }
    
    a { color: #80bfff; text-decoration: none; transition: color 0.2s; }
    a:hover { color: #fff; text-decoration: underline; }

    hr { border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 2em 0; }

    #servergreeting {
      background: rgba(0,0,0,0.3);
      padding: 20px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.05);
      margin-bottom: 2em;
    }
    #servergreeting p:first-child { margin-top: 0; }
    #servergreeting p:last-child { margin-bottom: 0; }

    .queue-times {
      font-family: 'Courier New', Courier, monospace;
      background: rgba(0,0,0,0.3);
      padding: 15px;
      border-radius: 8px;
      color: #81d4fa;
      font-size: 0.9em;
      margin: 1em 0;
    }

    .self-service-links {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 10px 20px;
      margin: 2em 0;
      padding: 15px;
      background: rgba(255,255,255,0.03);
      border-radius: 8px;
    }
    .self-service-links a {
      font-size: 0.9em;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 600;
    }

    #recent-images {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 15px;
      margin-top: 1.5em;
    }
    .recent-image {
      aspect-ratio: 1 / 1;
      overflow: hidden;
      border-radius: 8px;
      border: 2px solid rgba(255,255,255,0.1);
      transition: transform 0.2s, border-color 0.2s;
    }
    .recent-image:hover {
      transform: scale(1.05);
      border-color: #80bfff;
      box-shadow: 0 4px 15px rgba(0,0,0,0.5);
    }
    .recent-image img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .view-all-images { text-align: center; margin-top: 1.5em; font-size: 0.9em;}

    pre.raw-json {
      background: #0a0e17;
      color: #a5d6a7;
      padding: 20px;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 0.85em;
      border: 1px solid #1a2233;
      box-shadow: inset 0 2px 10px rgba(0,0,0,0.5);
    }

    @media (max-width: 600px) {
      .main-container { padding: 20px; margin-top: 10px; }
      h1 { font-size: 1.8rem; }
      #recent-images { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
    }
  </style>
</head>
<body>
  ${backgroundHtml}
  <div class="main-container glass-panel">
    ${headerHtml}
    <hr/>
    ${getSelfServiceLinks()}
    <h2>Raw Service Info</h2>
    <pre class="raw-json">${JSON.stringify(info, null, 2)}</pre>
  </div>
</body>
</html>`;
}

/* ────────────────  header & helper functions  ──────────────── */

function buildInfoPageHeader(info: ServiceInfo) {
  const title = getServerTitle();
  let html = `<h1>${escapeHtml(title)}</h1>`;

  html += customGreeting; 

  if (config.staticServiceInfo) {
    return html;
  }

  const waits: string[] = [];
  for (const modelFamily of config.allowedModelFamilies) {
    const service = getServiceForFamily(modelFamily);
    const hasKeys = keyPool.list().some(
      (k) => k.service === service && k.modelFamilies.includes(modelFamily)
    );
    const wait = info[modelFamily]?.estimatedQueueTime;
    if (hasKeys && wait) {
      waits.push(`<strong>${getFriendlyModelFamilyName(modelFamily)}</strong>: ${wait}`);
    }
  }

  if (waits.length > 0) {
    html += `<h2>Estimated Queue Times</h2>`;
    html += `<div class="queue-times">${waits.join(" <span style='color:rgba(255,255,255,0.2)'>|</span> ")}</div>`;
  }

  html += buildRecentImageSection();

  return html;
}

function getSelfServiceLinks() {
  if (config.gatekeeper !== "user_token") return "";
  const links = [["Check Token", "/user/lookup"]];
  if (config.captchaMode !== "none") {
    links.unshift(["Request Token", "/user/captcha"]);
  }
  return `<div class="self-service-links">${links
    .map(([t, l]) => `<a href="${l}">${t}</a>`)
    .join(" | ")}</div>`;
}

function getServerTitle() {
  if (process.env.SERVER_TITLE) return process.env.SERVER_TITLE;
  if (process.env.SPACE_ID)
    return `${process.env.SPACE_AUTHOR_NAME} / ${process.env.SPACE_TITLE}`;
  if (process.env.RENDER)
    return `Render / ${process.env.RENDER_SERVICE_NAME}`;
  return "AI Proxy Tunnel";
}

function buildRecentImageSection() {
  const imageModels: ModelFamily[] = [
    "azure-dall-e",
    "dall-e",
    "gpt-image",
    "azure-gpt-image",
  ];
  if (
    !config.showRecentImages ||
    imageModels.every((f) => !config.allowedModelFamilies.includes(f))
  ) {
    return "";
  }

  const recentImages = getLastNImages(12).reverse();
  if (recentImages.length === 0) {
    return "";
  }

  let html = `<h2>Recent Generations</h2>`;
  html += `<div id="recent-images">`;
  for (const { url, prompt } of recentImages) {
    const thumbUrl = url.replace(/\.png$/, "_t.jpg");
    const escapedPrompt = escapeHtml(prompt);
    html += `<div class="recent-image">
<a href="${url}" target="_blank"><img src="${thumbUrl}" title="${escapedPrompt}" alt="${escapedPrompt}"/></a></div>`;
  }
  html += `</div><p class="view-all-images">
<a href="/user/image-history">View full gallery →</a></p>`;
  return html;
}

function escapeHtml(unsafe: string) {
  if (typeof unsafe !== 'string') return '';
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\[/g, "&#91;")
    .replace(/]/g, "&#93;");
}

function getExternalUrlForHuggingfaceSpaceId(spaceId: string) {
  try {
    const [u, s] = spaceId.split("/");
    return `https://${u}-${s.replace(/_/g, "-")}.hf.space`;
  } catch {
    return "";
  }
}

/* ────────────────  ROUTER  ─────────────────────────────────── */
const infoPageRouter = Router();

infoPageRouter.use(
  express.json({ limit: "1mb" }),
  express.urlencoded({ extended: true, limit: "1mb" }),
  withSession,
  injectCsrfToken,
  checkCsrfToken
);

infoPageRouter.post(LOGIN_ROUTE, (req, res) => {
  if (config.serviceInfoAuthMode === "password") {
    const password = (req.body.password || "").trim();
    if (config.serviceInfoPassword && password === config.serviceInfoPassword) {
      req.session!.infoPageAuthed = true;
      return res.redirect("/");
    } else {
      return res
        .status(401)
        .send(renderLoginPage(res.locals.csrfToken, "Invalid password. Please try again."));
    }
  } else {
    const token = (req.body.token || "").trim();
    const user = getUser(token); 
    
    if (user && !user.disabledAt) {
      req.session!.infoPageAuthed = true;
      return res.redirect("/");
    } else if (user && user.disabledAt) {
      const reason = user.disabledReason || "Your account has been disabled";
      return res
        .status(401)
        .send(renderLoginPage(res.locals.csrfToken, `Access denied: ${reason}`));
    } else {
      return res
        .status(401)
        .send(renderLoginPage(res.locals.csrfToken, "Invalid token. Please try again."));
    }
  }
});

if (config.enableInfoPageLogin) {
  infoPageRouter.get(LOGIN_ROUTE, requireLogin, handleInfoPage);
} else {
  infoPageRouter.get(LOGIN_ROUTE, handleInfoPage);
}

export { infoPageRouter };
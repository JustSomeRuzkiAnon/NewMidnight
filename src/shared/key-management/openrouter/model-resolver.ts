import { ModelMetadata, Whitelist } from "./whitelist-generator";

export type ResolveResult = [ModelMetadata | null, string | null];

function normalize(str: string) {
  return str.toLowerCase().replace(/[\.\-\/]/g, "");
}

export function resolveModel(
  userInput: string, 
  whitelist: Whitelist, 
  config: { allowPaid: boolean; allowModerated: boolean }
): ResolveResult {
  const allModels = Object.values(whitelist).flat();
  const inputLow = userInput.toLowerCase();

  console.log(`[Resolver] Resolving: '${userInput}'`);

  // 1. Прямое совпадение ID
  let foundModel = allModels.find(m => m.id.toLowerCase() === inputLow);
  
  if (foundModel) {
    console.log(`[Resolver] Exact match found: ${foundModel.id}`);
  }

  // 2. Умный поиск по шорткатам
  if (!foundModel) {
    const shortcuts: Record<string, RegExp> = {
      "openai/": /^(gpt|codex|chatgpt|o\d)/,
      "anthropic/": /^claude/,
      "google/": /^(gemini|gemma)/,
      "x-ai/": /^grok/,
      "deepseek/": /^deepseek/,
      "mistralai/": /^mistral/,
      "z-ai/": /^glm/,
      "amazon/": /^nova/,
      "moonshotai/": /^kimi/,
      "qwen/": /(qwen|qwq)/
    };

    let providerPrefix = Object.keys(shortcuts).find(p => shortcuts[p].test(inputLow));
    if (!providerPrefix && inputLow.includes("banana")) providerPrefix = "google/";

    console.log(`[Resolver] Detected prefix: ${providerPrefix || "NONE"}`);

    const candidates = allModels.filter(m => {
      if (providerPrefix && !m.id.startsWith(providerPrefix)) return false;
      
      const [p, name] = m.id.toLowerCase().split('/');
      
      // Стандартная проверка
      if (name === inputLow || name.includes(inputLow)) return true;

      if (normalize(name) === normalize(inputLow)) return true;
      
      return false;
    });

    console.log(`[Resolver] Candidates found: ${candidates.length}`);

    let bestMatch = candidates.find(m => m.id.split('/')[1].toLowerCase() === inputLow);
    
    if (!bestMatch) {
        bestMatch = candidates.find(m => normalize(m.id.split('/')[1]) === normalize(inputLow));
    }

    if (bestMatch) {
      console.log(`[Resolver] Best match selected: ${bestMatch.id}`);
      foundModel = bestMatch;
    } else if (candidates.length === 1) {
      console.log(`[Resolver] Single candidate selected: ${candidates[0].id}`);
      foundModel = candidates[0];
    } else {
      console.warn(`[Resolver] Ambiguous or no match for '${userInput}'`);
      return [null, "not_found"];
    }
  }

  // 3. Проверка прав
  const isPaid = foundModel.pricing.input !== "0" || foundModel.pricing.output !== "0";
  
  if (isPaid && !config.allowPaid) {
    console.warn(`[Resolver] Blocked PAID model: ${foundModel.id}`);
    return [null, "prohibit_paid"];
  }
  
  if (foundModel.is_moderated && !config.allowModerated) {
    console.warn(`[Resolver] Blocked MODERATED model: ${foundModel.id}`);
    return [null, "prohibit_moderated"];
  }

  return [foundModel, null];
}
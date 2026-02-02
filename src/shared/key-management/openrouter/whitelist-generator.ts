import { OPENROUTER_FAMILY_MAP } from "../../models";

export interface ModelMetadata {
  id: string;
  context: number;
  max_output: number | null;
  pricing: { input: string; output: string };
  supported_params: string[];
  default_params: Record<string, any>;
  is_moderated: boolean;
}

export type Whitelist = Record<string, ModelMetadata[]>;

export function generateWhitelist(rawResponse: any): Whitelist {
  console.log("[Whitelist] Starting generation...");
  
  const result: Whitelist = {};
  const stats: Record<string, number> = {};
  
  Object.values(OPENROUTER_FAMILY_MAP).forEach(cat => {
    result[cat] = [];
    stats[cat] = 0;
  });

  if (!rawResponse?.data) {
    console.error("[Whitelist] No data in rawResponse!");
    return result;
  }

  rawResponse.data.forEach((m: any) => {
    const processed: ModelMetadata = {
      id: m.id,
      context: m.context_length,
      max_output: m.top_provider?.max_completion_tokens ?? null,
      pricing: {
        input: m.pricing.prompt,
        output: m.pricing.completion
      },
      supported_params: m.supported_parameters || [],
      default_params: Object.fromEntries(
        Object.entries(m.default_parameters || {}).filter(([_, v]) => v !== null)
      ),
      is_moderated: m.top_provider?.is_moderated ?? false
    };

    let category = "OpRout_Other";
    for (const [regex, fam] of Object.entries(OPENROUTER_FAMILY_MAP)) {
       if (new RegExp(regex).test(m.id)) {
         category = fam;
         break;
       }
    }
    
    if (!result[category]) result[category] = [];
    result[category].push(processed);
    stats[category]++;
  });

  console.log("--- OpenRouter Whitelist Stats ---");
  Object.entries(stats).forEach(([fam, count]) => {
    if (count > 0) console.log(`${fam}: ${count} models`);
  });
  console.log("----------------------------------");

  return result;
}
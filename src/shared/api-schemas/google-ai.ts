import { z } from "zod";
import { config } from "../../config";
import {
  flattenOpenAIMessageContent,
  OpenAIV1ChatCompletionSchema,
} from "./openai";
import { APIFormatTransformer } from "./index";

const TextPartSchema = z.object({ 
  text: z.string(),
  thought: z.boolean().optional()
});

const GOOGLEAI_OUTPUT_MAX = config.maxOutputTokensGoogleAI;

// ИСПРАВЛЕНО: Поддержка и inlineData (SDK), и inline_data (REST)
const InlineDataPartSchema = z.union([
  // Вариант 1: CamelCase (как в SDK)
  z.object({
    inlineData: z.object({
      mimeType: z.string(),
      data: z.string(),
    }),
  }),
  // Вариант 2: SnakeCase (как в REST API / SillyTavern)
  z.object({
    inline_data: z.object({
      mime_type: z.string(),
      data: z.string(),
    }),
  }).transform((val) => ({
    // Трансформируем в CamelCase, чтобы трансформеру было удобно
    inlineData: {
      mimeType: val.inline_data.mime_type,
      data: val.inline_data.data,
    },
  })),
]);

const PartSchema = z.union([TextPartSchema, InlineDataPartSchema]);

const GoogleAIV1ContentSchema = z.object({
  parts: z
    .union([PartSchema, z.array(PartSchema)])
    .transform((val) => (Array.isArray(val) ? val : [val])),
  role: z.enum(["user", "model"]).optional(),
});

const SafetySettingsSchema = z
  .array(
    z.object({
      category: z.enum([
        "HARM_CATEGORY_HARASSMENT",
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
        "HARM_CATEGORY_CIVIC_INTEGRITY",
      ]),
      threshold: z.enum([
        "OFF",
        "BLOCK_NONE",
        "BLOCK_ONLY_HIGH",
        "BLOCK_MEDIUM_AND_ABOVE",
        "BLOCK_LOW_AND_ABOVE",
        "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
      ]),
    })
  )
  .optional();

const GoogleSearchToolSchema = z.object({
  googleSearch: z.object({}),
});

const ToolSchema = GoogleSearchToolSchema;

export const GoogleAIV1GenerateContentSchema = z
  .object({
    model: z.string().max(100),
    stream: z.boolean().optional().default(false),
    contents: z.array(GoogleAIV1ContentSchema),
    tools: z.array(ToolSchema).optional(),
    safetySettings: SafetySettingsSchema,
    systemInstruction: GoogleAIV1ContentSchema.optional(),
    system_instruction: GoogleAIV1ContentSchema.optional(),
    generationConfig: z
      .object({
        temperature: z.number().min(0).max(2).optional(),
        maxOutputTokens: z.coerce
          .number()
          .int()
          .optional()
          .default(16)
          .transform((v) => Math.min(v, GOOGLEAI_OUTPUT_MAX)),
        candidateCount: z.literal(1).optional(),
        topP: z.number().min(0).max(1).optional(),
        topK: z.number().min(0).max(500).optional(),
        stopSequences: z.array(z.string().max(500)).max(5).optional(),
        seed: z.number().int().optional(),
        frequencyPenalty: z.number().optional().default(0),
        presencePenalty: z.number().optional().default(0),
        thinkingConfig: z.object({
          includeThoughts: z.boolean().optional(),
          thinkingBudget: z.union([
            z.literal("auto"),
            z.number().int()
          ]).optional()
        }).optional(),
        responseModalities: z.any().optional(),
      })
      .default({}),
  })
  .strip();

export type GoogleAIChatMessage = z.infer<
  typeof GoogleAIV1GenerateContentSchema
>["contents"][0];

// --- ТРАНСФОРМЕРЫ ---

export const transformOpenAIToGoogleAI: APIFormatTransformer<
  typeof GoogleAIV1GenerateContentSchema
> = async (req) => {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse({
    ...body,
    model: "gpt-3.5-turbo", // Dummy model for validation
  });
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-Google AI request"
    );
    throw result.error;
  }

  const { messages, ...rest } = result.data;

  const foundNames = new Set<string>();
  const contents = messages
    .map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      const text = flattenOpenAIMessageContent(m.content);
      const propName = m.name?.trim();
      const textName =
        m.role === "system" ? "" : text.match(/^(.{0,50}?): /)?.[1]?.trim();
      const name =
        propName || textName || (role === "model" ? "Character" : "User");

      foundNames.add(name);

      const textPrefix = textName ? "" : `${name}: `;
      return {
        parts: [{ text: textPrefix + text }],
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      };
    })
    .reduce<GoogleAIChatMessage[]>((acc, msg) => {
      const last = acc[acc.length - 1];
      if (last?.role === msg.role && 'text' in last.parts[0] && 'text' in msg.parts[0]) {
        last.parts[0].text += "\n\n" + msg.parts[0].text;
      } else {
        acc.push(msg);
      }
      return acc;
    }, []);

  let stops = rest.stop
    ? Array.isArray(rest.stop)
      ? rest.stop
      : [rest.stop]
    : [];
  stops.push(...Array.from(foundNames).map((name) => `\n${name}:`));
  stops = [...new Set(stops)].slice(0, 5);

  let tools: z.infer<typeof ToolSchema>[] | undefined = undefined;
  let responseModalities: string[] | undefined = undefined;

  if (req.body.use_google_search === true) {
    req.log.info("Google Search tool requested.");
    tools = [{ googleSearch: {} }];
    responseModalities = ["TEXT"];
  }

  let thinkingConfig = undefined;
  if (body.generationConfig?.thinkingConfig || body.thinkingConfig) {
    thinkingConfig = body.generationConfig?.thinkingConfig || body.thinkingConfig;
  }

  return {
    model: req.body.model,
    stream: rest.stream,
    contents,
    tools: tools,
    generationConfig: {
      maxOutputTokens: rest.max_tokens,
      stopSequences: stops,
      topP: rest.top_p,
      topK: 40,
      temperature: rest.temperature,
      seed: rest.seed,
      frequencyPenalty: rest.frequency_penalty,
      presencePenalty: rest.presence_penalty,
      responseModalities: responseModalities,
      ...(thinkingConfig ? { thinkingConfig } : {})
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
    ],
    ...(req.body.system_instruction && { system_instruction: req.body.system_instruction }),
    ...(req.body.systemInstruction && { systemInstruction: req.body.systemInstruction }),
  };
};

export const transformGoogleAIToOpenAI: APIFormatTransformer<
  typeof OpenAIV1ChatCompletionSchema
> = async (req) => {
  const { body } = req;
  
  const parseResult = GoogleAIV1GenerateContentSchema.safeParse(body);
  if (!parseResult.success) {
    req.log.warn(
      { issues: parseResult.error.issues, body },
      "Invalid Google AI request body during transformation"
    );
    throw parseResult.error;
  }

  const googleData = parseResult.data;
  const messages: any[] = [];

  // 1. System Instruction
  if (googleData.systemInstruction || (body as any).system_instruction) {
    const sysParts = googleData.systemInstruction?.parts || (body as any).system_instruction?.parts;
    if (sysParts) {
      const sysText = Array.isArray(sysParts) 
        ? sysParts.map((p: any) => p.text).join("") 
        : (sysParts as any).text;
        
      if (sysText) {
        messages.push({ role: "system", content: sysText });
      }
    }
  }

  // 2. Contents
  if (googleData.contents) {
    for (const msg of googleData.contents) {
      const role = msg.role === "model" ? "assistant" : "user";
      
      const parts = Array.isArray(msg.parts) ? msg.parts : [msg.parts];
      const content: any[] = [];

      for (const part of parts) {
        if ("text" in part && part.text) {
          content.push({ type: "text", text: part.text });
        }
        // Благодаря .transform() в схеме, здесь всегда будет inlineData (camelCase)
        else if ("inlineData" in part && part.inlineData) {
          content.push({
            type: "image_url",
            image_url: {
              url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
            }
          });
        }
      }

      if (content.length === 1 && content[0].type === "text") {
        messages.push({ role, content: content[0].text });
      } else if (content.length > 0) {
        messages.push({ role, content });
      }
    }
  }

  const genConfig = googleData.generationConfig || {};

  // 3. Thinking (Reasoning)
  let reasoning: any = undefined;
  if (genConfig.thinkingConfig && genConfig.thinkingConfig.includeThoughts) {
    // Если бюджет задан числом, передаем его в max_tokens
    if (typeof genConfig.thinkingConfig.thinkingBudget === 'number') {
      reasoning = {
        max_tokens: genConfig.thinkingConfig.thinkingBudget
      };
    } 
    // Если бюджет 'auto' или не задан, но мысли включены, можно передать пустой объект или дефолт,
    // но обычно для OpenRouter важно именно наличие поля reasoning с max_tokens > 0
    else if (genConfig.thinkingConfig.thinkingBudget === 'auto') {
       // Опционально: можно не передавать max_tokens, чтобы модель решала сама,
       // но структура reasoning должна присутствовать, чтобы включить режим.
       // Однако OpenRouter спецификация обычно требует max_tokens для активации.
       // Оставим undefined, если бюджет не число, или можно поставить дефолт (например 1024).
    }
  } else {
      reasoning = {
        exclude: true
      };
    } 

  return {
    model: googleData.model,
    messages: messages as any,
    stream: googleData.stream || false,
    max_tokens: genConfig.maxOutputTokens,
    temperature: genConfig.temperature ?? 1,
    top_p: genConfig.topP ?? 1,
    frequency_penalty: genConfig.frequencyPenalty ?? 0,
    presence_penalty: genConfig.presencePenalty ?? 0,
    stop: genConfig.stopSequences,
    seed: genConfig.seed,
    reasoning: reasoning,
  };
};

export function containsImageContent(contents: GoogleAIChatMessage[]): boolean {
  return contents.some(content => {
    const parts = Array.isArray(content.parts) ? content.parts : [content.parts];
    return parts.some(part => 'inlineData' in part || 'inline_data' in part);
  });
}
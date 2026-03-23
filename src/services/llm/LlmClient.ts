import type { LlmMessage } from "./prompt.js";
import { OpenAiClient } from "./OpenAiClient.js";

export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type LlmJsonWithUsage = {
  data: unknown;
  usage: LlmUsage | null;
};

export interface ILlmClient {
  generateJson(messages: LlmMessage[], model: string): Promise<unknown>;
  generateText(messages: LlmMessage[], model: string): Promise<string>;
  generateJsonWithUsage(messages: LlmMessage[], model: string): Promise<LlmJsonWithUsage>;
}

export const llmClient: ILlmClient = (() => {
  const provider = process.env.LLM_PROVIDER ?? "openai";

  if (provider === "openai") {
    return new OpenAiClient();
  }

  throw new Error(`Unsupported provider: ${provider}`);
})();

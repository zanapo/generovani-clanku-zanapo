import type { ILlmClient } from "./LlmClient.js";
import type { LlmJsonWithUsage, LlmUsage } from "./LlmClient.js";
import type { LlmMessage } from "./prompt.js";

type OpenAiChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export class OpenAiClient implements ILlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    this.timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? 90000);

    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is not set");
    }
  }

  async generateJson(messages: LlmMessage[], model: string): Promise<unknown> {
    const result = await this.requestCompletion(messages, model, true);
    try {
      return JSON.parse(result.content);
    } catch {
      throw new Error("OpenAI did not return valid JSON content");
    }
  }

  async generateJsonWithUsage(messages: LlmMessage[], model: string): Promise<LlmJsonWithUsage> {
    const result = await this.requestCompletion(messages, model, true);
    try {
      return {
        data: JSON.parse(result.content),
        usage: result.usage
      };
    } catch {
      throw new Error("OpenAI did not return valid JSON content");
    }
  }

  async generateText(messages: LlmMessage[], model: string): Promise<string> {
    const result = await this.requestCompletion(messages, model, false);
    return result.content;
  }

  private async requestCompletion(messages: LlmMessage[], model: string, jsonMode: boolean): Promise<{
    content: string;
    usage: LlmUsage | null;
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.5,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {})
        })
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`OpenAI request timeout after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`OpenAI request failed (${response.status}): ${bodyText}`);
    }

    const data = (await response.json()) as OpenAiChatResponse;
    const content = data.choices?.[0]?.message?.content;

    if (!content || !content.trim()) {
      throw new Error("OpenAI returned empty response");
    }
    const usage = data.usage
      ? {
          promptTokens: Number(data.usage.prompt_tokens ?? 0),
          completionTokens: Number(data.usage.completion_tokens ?? 0),
          totalTokens: Number(data.usage.total_tokens ?? 0)
        }
      : null;
    return {
      content,
      usage
    };
  }
}

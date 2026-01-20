import type { Message } from "../types/chat";

export type LLMProvider = "openai" | "deepseek" | "gemini";

type SendChatParams = {
  messages: Message[];
  signal?: AbortSignal;
  provider?: LLMProvider;
};

type OpenAIChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiContent = {
  role: "user" | "model";
  parts: Array<{ text: string }>;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
};

function getProvider(requested?: LLMProvider): LLMProvider {
  if (requested) return requested;
  const env = import.meta.env.VITE_LLM_PROVIDER?.trim();
  if (env === "openai" || env === "deepseek" || env === "gemini") return env;
  return "openai";
}

function isAbortError(err: unknown) {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

export async function sendChat({
  messages,
  signal,
  provider: requestedProvider,
}: SendChatParams): Promise<string> {
  const provider = getProvider(requestedProvider);

  if (provider === "gemini") {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY?.trim();
    if (!apiKey) throw new Error("Missing Gemini API key");
    const model = import.meta.env.VITE_GEMINI_MODEL?.trim() || "gemini-1.5-flash";

    const contents: GeminiContent[] = messages.map((m) => {
      if (m.role === "assistant") {
        return { role: "model", parts: [{ text: m.content }] };
      }
      if (m.role === "system") {
        return { role: "user", parts: [{ text: `System: ${m.content}` }] };
      }
      return { role: "user", parts: [{ text: m.content }] };
    });

    const url = `${GEMINI_BASE_URL}/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents }),
        signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new Error("Invalid API key");
      }
      if (!response.ok) throw new Error(`LLM error: ${response.status}`);

      const data = (await response.json()) as GeminiResponse;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) throw new Error("Empty response");
      return text;
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (err instanceof TypeError) throw new Error("Network error");
      throw err;
    }
  }

  const apiKey =
    provider === "deepseek"
      ? import.meta.env.VITE_DEEPSEEK_API_KEY?.trim()
      : import.meta.env.VITE_OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(provider === "deepseek" ? "Missing DeepSeek API key" : "Missing OpenAI API key");
  }

  const model =
    provider === "deepseek"
      ? import.meta.env.VITE_DEEPSEEK_MODEL?.trim() || "deepseek-chat"
      : import.meta.env.VITE_OPENAI_MODEL?.trim() || "openai-5.2";

  const openAiMessages: OpenAIChatMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const url = provider === "deepseek" ? DEEPSEEK_URL : OPENAI_URL;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages: openAiMessages }),
      signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error("Invalid API key");
    }
    if (!response.ok) throw new Error(`LLM error: ${response.status}`);

    const data = (await response.json()) as OpenAIResponse;
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("Empty response");
    return content;
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (err instanceof TypeError) throw new Error("Network error");
    throw err;
  }
}

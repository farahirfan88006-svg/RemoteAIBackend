import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProvider, invokeProvider } from "../../lib/ai/utils/providerResolver.js";
import openaiProvider from "../../lib/ai/providers/openai.provider.js";
import geminiProvider from "../../lib/ai/providers/gemini.provider.js";
import openrouterProvider from "../../lib/ai/providers/openrouter.provider.js";

function clearProviderEnv() {
  delete process.env.AI_PROVIDER;
  delete process.env.AI_DEFAULT_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
}

test("resolveProvider falls back to free when no AI_PROVIDER is configured", () => {
  clearProviderEnv();
  const { providerId, providerName, instance } = resolveProvider();
  assert.equal(providerId, "primary");
  assert.equal(providerName, "free");
  assert.equal(typeof instance.generateText, "function");
});

test("resolveProvider falls back to free for an unrecognized provider name (never crashes)", () => {
  clearProviderEnv();
  const { providerName } = resolveProvider({ provider: "not-a-real-provider" });
  assert.equal(providerName, "free");
});

test("resolveProvider falls back to free when the requested provider has no API key configured", () => {
  clearProviderEnv();
  const { providerName } = resolveProvider({ provider: "openai" });
  assert.equal(providerName, "free");
});

test("resolveProvider selects openai once OPENAI_API_KEY is configured (provider switching)", () => {
  clearProviderEnv();
  process.env.OPENAI_API_KEY = "test-key";
  const { providerName, instance } = resolveProvider({ provider: "openai" });
  assert.equal(providerName, "openai");
  assert.equal(instance, openaiProvider);
  clearProviderEnv();
});

test("resolveProvider honors AI_PROVIDER env var when no explicit override is passed", () => {
  clearProviderEnv();
  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-key";
  const { providerName } = resolveProvider();
  assert.equal(providerName, "gemini");
  clearProviderEnv();
});

test("openai provider throws a clear, descriptive error when called without an API key", async () => {
  clearProviderEnv();
  await assert.rejects(() => openaiProvider.generateText("hello"), /OPENAI_API_KEY/);
});

test("openai provider calls the chat completions endpoint and maps the response (mocked fetch)", async () => {
  clearProviderEnv();
  process.env.OPENAI_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, requestInit) => {
    assert.match(url, /api\.openai\.com/);
    const body = JSON.parse(requestInit.body);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content, "be nice");
    return {
      ok: true,
      json: async () => ({
        model: "gpt-4o-mini",
        choices: [{ message: { content: "Hello from OpenAI" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    };
  };

  try {
    const result = await openaiProvider.generateText("hi", { systemInstructions: "be nice" });
    assert.equal(result.text, "Hello from OpenAI");
    assert.equal(result.provider, "openai");
    assert.equal(result.raw.usage.totalTokens, 15);
  } finally {
    globalThis.fetch = originalFetch;
    clearProviderEnv();
  }
});

test("openai provider surfaces a clear error on a non-OK response instead of crashing (mocked fetch)", async () => {
  clearProviderEnv();
  process.env.OPENAI_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => "invalid api key",
  });

  try {
    await assert.rejects(() => openaiProvider.generateText("hi"), /OpenAI API error \(401\)/);
  } finally {
    globalThis.fetch = originalFetch;
    clearProviderEnv();
  }
});

test("gemini and openrouter providers report unavailable without their API keys", () => {
  clearProviderEnv();
  assert.equal(geminiProvider.isAvailable(), false);
  assert.equal(openrouterProvider.isAvailable(), false);
});

test("gemini provider calls the generateContent endpoint and maps the response (mocked fetch)", async () => {
  clearProviderEnv();
  process.env.GEMINI_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    assert.match(url, /generativelanguage\.googleapis\.com/);
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Hello from Gemini" }] } }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
      }),
    };
  };

  try {
    const result = await geminiProvider.generateText("hi");
    assert.equal(result.text, "Hello from Gemini");
    assert.equal(result.provider, "gemini");
    assert.equal(result.raw.usage.totalTokens, 12);
  } finally {
    globalThis.fetch = originalFetch;
    clearProviderEnv();
  }
});

test("invokeProvider normalizes the free provider response shape", async () => {
  clearProviderEnv();
  const { instance } = resolveProvider();
  const { text, raw } = await invokeProvider(instance, { prompt: "hello world" });
  assert.equal(typeof text, "string");
  assert.match(text, /hello world/);
  assert.equal(raw.provider, "free");
});

test("invokeProvider surfaces provider errors to the caller instead of swallowing them", async () => {
  const failingProvider = {
    generateText: async () => {
      throw new Error("boom");
    },
  };
  await assert.rejects(() => invokeProvider(failingProvider, { prompt: "x" }), /boom/);
});

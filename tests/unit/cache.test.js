import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCacheKey, getCachedResponse, setCachedResponse } from "../../lib/cache/aiCache.js";

test("buildCacheKey is stable for identical userId+feature+input", () => {
  const keyA = buildCacheKey("user1", "resumeAnalyzer", "same input");
  const keyB = buildCacheKey("user1", "resumeAnalyzer", "same input");
  assert.equal(keyA, keyB);
});

test("buildCacheKey differs when the input text differs", () => {
  const keyA = buildCacheKey("user1", "resumeAnalyzer", "same input");
  const keyC = buildCacheKey("user1", "resumeAnalyzer", "different input");
  assert.notEqual(keyA, keyC);
});

test("buildCacheKey differs when the user differs", () => {
  const keyA = buildCacheKey("user1", "resumeAnalyzer", "same input");
  const keyD = buildCacheKey("user2", "resumeAnalyzer", "same input");
  assert.notEqual(keyA, keyD);
});

test("buildCacheKey differs when the feature differs", () => {
  const keyA = buildCacheKey("user1", "resumeAnalyzer", "same input");
  const keyE = buildCacheKey("user1", "careerCoach", "same input");
  assert.notEqual(keyA, keyE);
});

test("getCachedResponse is a safe no-op (returns null) when REDIS_URL is not configured", async () => {
  delete process.env.REDIS_URL;
  const cached = await getCachedResponse("user1", "resumeAnalyzer", "hello");
  assert.equal(cached, null);
});

test("setCachedResponse is a safe no-op (returns false, does not throw) when REDIS_URL is not configured", async () => {
  delete process.env.REDIS_URL;
  const saved = await setCachedResponse("user1", "resumeAnalyzer", "hello", { result: "some AI output" });
  assert.equal(saved, false);
});

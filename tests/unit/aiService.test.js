import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAIFeature } from '../../lib/ai/services/aiService.js';
import { resolveProvider, invokeProvider } from '../../lib/ai/utils/providerResolver.js';

// Regression test for the stabilization-pass bug: lib/ai/services/*,
// lib/ai/validators/*, lib/ai/prompts/basePrompt.js, and
// lib/ai/utils/providerResolver.js used CommonJS require()/module.exports
// inside an ESM ("type": "module") project, which threw a ReferenceError
// on every load. Every AI feature controller's dynamic `await import(...)`
// swallowed that error and silently fell back to its local, non-AI logic.
// If this test fails to even import, the regression has come back.

test('providerResolver resolves the configured active provider', () => {
  const { instance, providerId, providerName } = resolveProvider();
  assert.equal(providerId, 'primary');
  assert.equal(providerName, 'free');
  assert.equal(typeof instance.generateText, 'function');
});

test('invokeProvider normalizes the free provider response shape', async () => {
  const { instance } = resolveProvider();
  const { text, raw } = await invokeProvider(instance, { prompt: 'hello world' });
  assert.equal(typeof text, 'string');
  assert.match(text, /hello world/);
  assert.equal(raw.provider, 'free');
});

test('runAIFeature() returns the standard response envelope on success', async () => {
  const result = await runAIFeature({
    feature: 'resumeAnalyzer',
    user: { _id: '000000000000000000000001' },
    prompt: 'A sample resume with more than fifty characters of content for validation.',
    options: {
      supportedFeatures: ['resumeAnalyzer'],
      maxLength: 12000,
      systemInstructions: 'test instructions',
      saveToHistory: false,
      plan: 'free',
      usageRemaining: 2,
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.plan, 'free');
  assert.equal(result.usageRemaining, 2);
  assert.equal(result.data.feature, 'resumeAnalyzer');
  assert.equal(typeof result.data.result, 'string');
  assert.deepEqual(result.errors, []);
});

test('runAIFeature() returns a validation error envelope for an empty prompt', async () => {
  const result = await runAIFeature({
    feature: 'resumeAnalyzer',
    user: { _id: '000000000000000000000001' },
    prompt: '',
    options: { supportedFeatures: ['resumeAnalyzer'] },
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.length > 0);
  assert.equal(result.data, null);
});

test('runAIFeature() rejects a feature not present in supportedFeatures', async () => {
  const result = await runAIFeature({
    feature: 'somethingUnregistered',
    user: { _id: '000000000000000000000001' },
    prompt: 'valid prompt text here',
    options: { supportedFeatures: ['resumeAnalyzer'] },
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => /unsupported/i.test(e)));
});

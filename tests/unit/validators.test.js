import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize } from '../../lib/ai/validators/sanitizeInput.js';
import { validateAIRequest } from '../../lib/ai/validators/validateRequest.js';

test('sanitize() strips control characters and collapses blank lines', () => {
  const dirty = 'Hello\u0000World\r\n\r\n\r\n\r\nSecond line   ';
  const clean = sanitize(dirty);
  assert.doesNotMatch(clean, /\u0000/);
  assert.doesNotMatch(clean, /\n{3,}/);
  assert.equal(clean.endsWith(' '), false);
});

test('sanitize() preserves normal resume-style text', () => {
  const text = 'John Doe\nSoftware Engineer\n\n5 years experience in Node.js and React.';
  assert.equal(sanitize(text), text);
});

test('validateAIRequest() rejects empty prompts', () => {
  const { valid, errors } = validateAIRequest({
    feature: 'resumeAnalyzer',
    prompt: '   ',
    supportedFeatures: ['resumeAnalyzer'],
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /empty/i.test(e)));
});

test('validateAIRequest() rejects unsupported/unregistered features', () => {
  const { valid, errors } = validateAIRequest({
    feature: 'notARealFeature',
    prompt: 'some valid prompt text',
    supportedFeatures: ['resumeAnalyzer', 'careerCoach'],
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /unsupported/i.test(e)));
});

test('validateAIRequest() rejects prompts exceeding maxLength', () => {
  const { valid, errors } = validateAIRequest({
    feature: 'resumeAnalyzer',
    prompt: 'a'.repeat(20),
    supportedFeatures: ['resumeAnalyzer'],
    maxLength: 10,
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /maximum length/i.test(e)));
});

test('validateAIRequest() accepts a well-formed request', () => {
  const { valid, errors } = validateAIRequest({
    feature: 'resumeAnalyzer',
    prompt: 'A perfectly reasonable resume analysis request.',
    supportedFeatures: ['resumeAnalyzer'],
    maxLength: 12000,
  });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

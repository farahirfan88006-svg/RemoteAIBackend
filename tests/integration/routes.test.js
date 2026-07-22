import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Required env vars (see src/config/env.js) must be set before createApp()
// is imported/invoked. No real MongoDB connection is made in this suite —
// createApp() never calls mongoose.connect() (that's server.js's job), and
// every case below returns before any route touches the database.
process.env.NODE_ENV ??= 'test';
process.env.MONGODB_URI ??= 'mongodb://localhost:27017/remoteai-test';
process.env.CORS_ORIGIN ??= 'http://localhost:3000';
process.env.JWT_SECRET ??= 'test-secret-for-route-smoke-tests';

const { createApp } = await import('../../src/app.js');

const AI_ENDPOINTS = [
  '/api/ai/resume-analyzer/analyze',
  '/api/ai/resume-rewrite/rewrite',
  '/api/ai/career-coach/advice',
  '/api/ai/cover-letter/generate',
  '/api/ai/mock-interview/start',
  '/api/ai/job-match-score/calculate',
];

let server;
let baseUrl;

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function assertStandardEnvelope(body) {
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'success'));
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'message'));
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'plan'));
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'usageRemaining'));
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'data'));
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'errors'));
}

for (const endpoint of AI_ENDPOINTS) {
  test(`POST ${endpoint} without a token returns 401 with the standard envelope`, async () => {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.json();

    assert.equal(res.status, 401);
    assertStandardEnvelope(body);
    assert.equal(body.success, false);
    assert.ok(body.errors.includes('MISSING_OR_INVALID_AUTH_HEADER'));
  });

  test(`POST ${endpoint} with a malformed token returns 401`, async () => {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not-a-real-jwt',
      },
      body: JSON.stringify({}),
    });
    const body = await res.json();

    assert.equal(res.status, 401);
    assertStandardEnvelope(body);
    assert.ok(body.errors.includes('INVALID_OR_EXPIRED_TOKEN'));
  });
}

test('an unmounted route returns a 404 with the centralized error envelope', async () => {
  const res = await fetch(`${baseUrl}/api/ai/does-not-exist`, { method: 'POST' });
  const body = await res.json();

  assert.equal(res.status, 404);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('/health is exempt from auth and reachable', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.notEqual(res.status, 401);
});

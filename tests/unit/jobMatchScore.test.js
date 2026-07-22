import { test } from 'node:test';
import assert from 'node:assert/strict';
import AIHistory from '../../src/models/AIHistory.js';
import { calculateJobMatchScore } from '../../src/controllers/ai/jobMatchScore.controller.js';

// This suite runs without a live MongoDB connection, so AIHistory.create is
// stubbed out — history persistence has its own coverage expectations
// (best-effort, never blocking the response) and isn't what this test is
// verifying. The deterministic scoring algorithm itself needs no DB at all.
AIHistory.create = async () => ({ _id: 'stub' });

function buildRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

test('calculateJobMatchScore returns a 0-100 deterministic score and standard envelope', async () => {
  const req = {
    user: { _id: '000000000000000000000001' },
    usage: { plan: 'free', remaining: 4 },
    body: {
      resumeText:
        'Experienced Node.js and React developer with 5 years building REST APIs, ' +
        'MongoDB schemas, and CI/CD pipelines for remote-first engineering teams.',
      jobDescription:
        'We are looking for a Node.js engineer with React experience to build and ' +
        'maintain our REST APIs and MongoDB-backed services in a remote team.',
      skills: ['Node.js', 'React', 'MongoDB', 'REST APIs'],
      experience: '5 years as a backend and full-stack engineer.',
      education: 'B.S. in Computer Science.',
    },
  };
  const res = buildRes();
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  await calculateJobMatchScore(req, res, next);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.plan, 'free');
  assert.equal(res.body.usageRemaining, 4);
  assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'errors'));
  assert.ok(typeof res.body.data.score === 'number');
  assert.ok(res.body.data.score >= 0 && res.body.data.score <= 100);
  assert.ok(Array.isArray(res.body.data.matchedSkills));
  assert.equal(nextCalled, true, 'next() should be called so incrementUsage middleware runs');
});

test('calculateJobMatchScore returns a 400 validation envelope for missing fields', async () => {
  const req = {
    user: { _id: '000000000000000000000001' },
    usage: { plan: 'free', remaining: 4 },
    body: { resumeText: 'Not enough other fields provided.' },
  };
  const res = buildRes();
  const next = () => {};

  await calculateJobMatchScore(req, res, next);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.ok(res.body.errors.length > 0);
  assert.equal(res.body.data, null);
});

// Live smoke test: one short calculus question and one follow-up, through the real
// Student → A2A → Tutor → Anthropic path. PAID — disabled unless you set a spending limit:
//
//   LIVE_SMOKE_MAX_USD=0.01 npm run smoke:live
//
// The key is read from ANTHROPIC_API_KEY (or .env / TUTOR_ENV_FILE) and is never printed.
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DEFAULT_MODEL, MODELS } from '../src/models.js';

// The Tutor's model (TUTOR_MODEL, as for the Tutor itself). Pricing from src/models.js
// (https://platform.claude.com/docs/en/about-claude/pricing) — re-check before relying on it.
const MODEL = process.env.TUTOR_MODEL || DEFAULT_MODEL;
const PRICE = MODELS[MODEL];
if (!PRICE) {
  console.log(`Not run: TUTOR_MODEL "${MODEL}" is not a supported model (${Object.keys(MODELS).join(', ')}).`);
  process.exit(2);
}
const QUESTIONS = [
  'What is the derivative of x^2, and why? Keep it short.',
  'Can you show the same idea for x^3?',
];
const PAID_CALLS = QUESTIONS.length;

// Worst case per call, deliberately pessimistic: every input character counted as half a token
// (real text is ~4 characters per token), history and question at their caps, full output cap.
const MAX_OUTPUT = 800;
const MAX_INPUT_CHARS = 500 /* system prompt */ + 2000 /* question */ + 12000 /* history cap */;
const worstCallUsd = ((MAX_INPUT_CHARS / 2) * PRICE.inputPerMTok + MAX_OUTPUT * PRICE.outputPerMTok) / 1e6;
const costOf = (u) => ((u?.inputTokens ?? 0) * PRICE.inputPerMTok + (u?.outputTokens ?? 0) * PRICE.outputPerMTok) / 1e6;
const usd = (n) => `$${n.toFixed(6)}`;

console.log('Live smoke test plan');
console.log(`  model:            ${MODEL} (no substitution: stops if unavailable)`);
console.log(`  calls:            1 model-availability check (Models API, not billed) + ${PAID_CALLS} paid Messages calls`);
console.log(`  pricing:          $${PRICE.inputPerMTok}/MTok input, $${PRICE.outputPerMTok}/MTok output (${PRICE.label})`);
console.log(`  output cap:       ${MAX_OUTPUT} tokens per answer, no retries`);
console.log(`  worst case:       ${usd(worstCallUsd)} per call, ${usd(worstCallUsd * PAID_CALLS)} total`);

const limit = Number(process.env.LIVE_SMOKE_MAX_USD);
if (!process.env.LIVE_SMOKE_MAX_USD || !Number.isFinite(limit) || limit <= 0) {
  console.log('\nNot run: set LIVE_SMOKE_MAX_USD to your total spending limit for this test, e.g.');
  console.log('  LIVE_SMOKE_MAX_USD=0.01 npm run smoke:live');
  process.exit(2);
}
if (worstCallUsd * PAID_CALLS > limit) {
  console.log(`\nNot run: the worst case (${usd(worstCallUsd * PAID_CALLS)}) exceeds your limit (${usd(limit)}).`);
  process.exit(2);
}

// Same key source as the Tutor in live mode. Presence only — never the value.
const envFile = process.env.TUTOR_ENV_FILE ?? '.env';
if (!process.env.ANTHROPIC_API_KEY && existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.log(`\nNot run: ANTHROPIC_API_KEY is not set (looked in the environment and ${envFile}). See README → Part 4 → Your API key.`);
  process.exit(2);
}
console.log(`  API key:          present (from ${process.env.TUTOR_ENV_FILE ? envFile : 'environment or .env'}; value not shown)`);
console.log(`  spending limit:   ${usd(limit)}\n`);

// 1. Is the model available to this account? (Models API — not a billed generation.)
const { default: Anthropic } = await import('@anthropic-ai/sdk');
try {
  const model = await new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim(), maxRetries: 0 }).models.retrieve(MODEL);
  console.log(`Model check: ${model.id} is available (${model.display_name}).\n`);
} catch (err) {
  const reason = err instanceof Anthropic.NotFoundError ? 'not available for this account'
    : err instanceof Anthropic.AuthenticationError ? 'authentication failed (check the key)'
      : err instanceof Anthropic.PermissionDeniedError ? 'permission denied' : `request failed (${err.constructor.name})`;
  console.log(`Model check failed: ${MODEL} — ${reason}. Stopping before any paid call.`);
  process.exit(1);
}

// 2. Real path: start a live-mode Tutor in this process, ask through the Student's A2A client.
process.env.TUTOR_MODE = 'live';
process.env.STUDENT_LOG_CONTENT = '0';
const { startTutorServer } = await import('../src/tutor-agent.js');
const { askTutor } = await import('../src/student-agent.js');
const { server, baseUrl } = await startTutorServer({ port: 0 });

const contextId = randomUUID();
let spent = 0;
let exitCode = 0;
try {
  for (const [i, question] of QUESTIONS.entries()) {
    if (spent + worstCallUsd > limit) {
      console.log(`Stopping: another call could exceed the limit (spent ${usd(spent)} of ${usd(limit)}).`);
      break;
    }
    console.log(`── Q${i + 1} (conversation ${contextId}) ──\n${question}\n`);
    const reply = await askTutor(baseUrl, question, { contextId });
    const cost = costOf(reply.tutor.usage);
    spent += cost;
    console.log(`── A${i + 1} (actual ${reply.tutor.model} response via A2A) ──\n${reply.text}\n`);
    console.log(`   usage: ${reply.tutor.usage.inputTokens} input / ${reply.tutor.usage.outputTokens} output tokens · ` +
      `latency ${reply.tutor.latencyMs} ms · stop ${reply.tutor.stopReason}${reply.tutor.truncated ? ' (cut off at cap)' : ''} · ` +
      `request ${reply.tutor.requestId} · cost ${usd(cost)}\n`);
  }
  console.log(`Total estimated cost: ${usd(spent)} (limit ${usd(limit)}). Billing records in the Anthropic Console are authoritative.`);
} catch (err) {
  console.log(`Live call failed: ${err.tutorError ? `${err.tutorError.code} — ${err.tutorError.message}` : err.message}`);
  console.log(`Spent so far (estimated): ${usd(spent)}. No automatic retry.`);
  exitCode = 1;
} finally {
  server.close();
}
process.exit(exitCode);

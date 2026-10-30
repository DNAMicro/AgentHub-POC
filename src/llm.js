// Anthropic access for the processes that call a model (the Hub's router; the Tutor's answers, scope
// checks and form review; the Library's answers and form review). Each agent is its own process and
// picks its own model and key variable from its configuration (useModel, called once at startup).
// Every call: explicit API key from this process's environment, no SDK retries, effort "low",
// sanitized errors. The key is never logged or returned.
import Anthropic from '@anthropic-ai/sdk';
import { existsSync } from 'node:fs';
import { DEFAULT_KEY_ENV, DEFAULT_MODEL, MODELS } from './models.js';

export { MODELS, DEFAULT_MODEL };
let current = { name: DEFAULT_MODEL, apiKeyEnv: DEFAULT_KEY_ENV };
let client = null;
// This process's model. No substitution: an unlisted name is a startup error, never a fallback.
export function useModel({ name = DEFAULT_MODEL, apiKeyEnv = DEFAULT_KEY_ENV } = {}) {
  if (!MODELS[name]) throw new Error(`Unknown model "${name}". Allowed: ${Object.keys(MODELS).join(', ')}.`);
  current = { name, apiKeyEnv };
  client = null;
}
export const modelName = () => current.name;
export const keyEnvName = () => current.apiKeyEnv;
export const priceOf = (name = current.name) => MODELS[name];

// Live mode may read the API key variable from a dotenv file the user created locally.
// Variables already set in the environment win over the file.
let dotenvLoaded = false;
export function loadDotenvOnce() {
  if (dotenvLoaded || process.env.TUTOR_LOAD_DOTENV === '0') return;
  dotenvLoaded = true;
  const file = process.env.TUTOR_ENV_FILE ?? '.env';
  if (existsSync(file)) process.loadEnvFile(file);
}

const apiKey = () => process.env[current.apiKeyEnv]?.trim();
export const keyConfigured = () => Boolean(apiKey());
// Where model calls go: the SDK honours ANTHROPIC_BASE_URL, which a parent environment (e.g. a
// local proxy) can set without you noticing. Shown at startup as host only.
export const apiHost = () => {
  try {
    return process.env.ANTHROPIC_BASE_URL ? `${new URL(process.env.ANTHROPIC_BASE_URL).host} (ANTHROPIC_BASE_URL override)` : 'api.anthropic.com';
  } catch {
    return 'invalid ANTHROPIC_BASE_URL';
  }
};

const ERROR_MESSAGES = {
  missing_credentials: 'Live mode is on, but {keyEnv} is not set in this agent’s environment.',
  authentication_failed: 'Anthropic rejected the API key (authentication failed).',
  permission_denied: 'The API key is not permitted to use {model}.',
  model_unavailable: 'The model {model} is not available for this account. No other model was substituted.',
  rate_limited: 'Anthropic’s rate limit was reached. Wait a moment, then ask again.',
  timeout: 'The model call timed out.',
  provider_unavailable: 'Anthropic is temporarily unavailable (server error or overloaded).',
  connection_failed: 'Could not connect to Anthropic.',
  bad_request: 'Anthropic rejected the request as invalid.',
  provider_error: 'Anthropic returned an unexpected error.',
  refusal: 'The model declined to answer this request.',
  truncated_no_text: 'The model used its whole output allowance before writing an answer.',
  bad_structured_output: 'The model returned a decision that did not match the required format.',
  busy: 'This conversation already has a question being answered. Wait for it to finish.',
  input_too_long: 'Questions are limited to 2000 characters.',
  internal_error: 'The agent hit an internal error.',
};

export class LlmError extends Error {
  constructor(code, { requestId = null, rateLimit = null } = {}) {
    super((ERROR_MESSAGES[code] ?? ERROR_MESSAGES.internal_error).replace('{model}', current.name).replace('{keyEnv}', current.apiKeyEnv));
    this.code = code;
    this.requestId = requestId; // Anthropic's request ID, safe to show and useful for support
    this.rateLimit = rateLimit; // numbers from the 429's anthropic-ratelimit-* headers (no secrets)
  }
}

// Which limit a 429 hit, from Anthropic's response headers. Kept to numbers/timestamps only.
function rateLimitInfo(err) {
  const h = (name) => err?.headers?.get?.(name) ?? null;
  const info = { retryAfterSeconds: h('retry-after') };
  for (const kind of ['requests', 'tokens', 'input-tokens', 'output-tokens']) {
    const limit = h(`anthropic-ratelimit-${kind}-limit`);
    if (limit !== null) info[kind] = { limit, remaining: h(`anthropic-ratelimit-${kind}-remaining`), reset: h(`anthropic-ratelimit-${kind}-reset`) };
  }
  // Anthropic's own explanation (e.g. which per-minute limit) — server log only, never sent to the browser.
  info.providerMessage = typeof err?.error?.error?.message === 'string' ? err.error.error.message.slice(0, 300) : null;
  return info;
}

// Map SDK errors to sanitized codes, most specific first. Raw provider messages are not passed on.
export function toLlmError(err) {
  if (err instanceof LlmError) return err;
  const requestId = err?.requestID ?? null;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError('timeout', { requestId });
  if (err instanceof Anthropic.APIConnectionError) return new LlmError('connection_failed', { requestId });
  if (err instanceof Anthropic.AuthenticationError) return new LlmError('authentication_failed', { requestId });
  if (err instanceof Anthropic.PermissionDeniedError) return new LlmError('permission_denied', { requestId });
  if (err instanceof Anthropic.NotFoundError) return new LlmError('model_unavailable', { requestId });
  if (err instanceof Anthropic.RateLimitError) return new LlmError('rate_limited', { requestId, rateLimit: rateLimitInfo(err) });
  if (err instanceof Anthropic.BadRequestError) return new LlmError('bad_request', { requestId });
  if (err instanceof Anthropic.InternalServerError) return new LlmError('provider_unavailable', { requestId });
  if (err instanceof Anthropic.APIError) return new LlmError('provider_error', { requestId });
  return new LlmError('internal_error');
}

export const pickUsage = (u = {}) => ({
  inputTokens: u.input_tokens ?? null,
  outputTokens: u.output_tokens ?? null,
  cacheReadInputTokens: u.cache_read_input_tokens ?? null,
  cacheCreationInputTokens: u.cache_creation_input_tokens ?? null,
});

// Combine usage across several calls for one request (e.g. scope check + answer + answer check).
export function sumUsage(list) {
  const present = list.filter(Boolean);
  if (present.length <= 1) return present[0] ?? null;
  const add = (k) => present.reduce((n, u) => (u[k] == null ? n : (n ?? 0) + u[k]), null);
  return { inputTokens: add('inputTokens'), outputTokens: add('outputTokens'), cacheReadInputTokens: add('cacheReadInputTokens'), cacheCreationInputTokens: add('cacheCreationInputTokens') };
}


// One Messages API call. With `schema`, the response is constrained to that JSON schema
// (structured outputs) and returned parsed; code must still validate the parsed value.
export async function callModel({ system, messages, maxTokens, timeoutMs, schema }) {
  if (!keyConfigured()) throw new LlmError('missing_credentials');
  // Explicit apiKey: the SDK then ignores other credential sources. maxRetries 0: no hidden retries.
  client ??= new Anthropic({ apiKey: apiKey(), maxRetries: 0 });
  const response = await client.messages.create({
    model: current.name,
    max_tokens: maxTokens,
    // Low effort suits chat/classification; thinking counts toward max_tokens on every listed model.
    output_config: { effort: 'low', ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
    system,
    messages,
  }, { timeout: timeoutMs });
  const requestId = response._request_id ?? null;
  if (response.stop_reason === 'refusal') throw new LlmError('refusal', { requestId });
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new LlmError(response.stop_reason === 'max_tokens' ? 'truncated_no_text' : 'provider_error', { requestId });
  let parsed = null;
  if (schema) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LlmError('bad_structured_output', { requestId });
    }
  }
  return { text, parsed, model: response.model, stopReason: response.stop_reason, truncated: response.stop_reason === 'max_tokens', usage: pickUsage(response.usage), requestId };
}

export const costOf = (u, name = current.name) => ((u?.inputTokens ?? 0) * MODELS[name].inputPerMTok + (u?.outputTokens ?? 0) * MODELS[name].outputPerMTok) / 1e6;

// A reply as kept in a routing/planning history: the start (what it is about) and the end (where a
// reply asks its question or invites the next message). A plain head cut dropped "If you tell me which
// book you meant…" from a long loan list, so the next message lost its meaning.
export function briefReply(text, head = 200, tail = 300) {
  const s = String(text ?? '');
  return s.length <= head + tail + 3 ? s : `${s.slice(0, head)} … ${s.slice(-tail)}`;
}

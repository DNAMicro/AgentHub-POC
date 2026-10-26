// A local stand-in for the Anthropic Messages API, so tests exercise the Tutor's real
// SDK code path (live mode with ANTHROPIC_BASE_URL pointed here) without any paid call.
import http from 'node:http';
import { once } from 'node:events';

const ERROR_TYPES = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error' };

export async function startFakeAnthropic() {
  const requests = []; // { headers, body } for every POST /v1/messages
  let behavior = defaultReply; // (body, n) => { status, json?, delayMs? }

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'unknown route' } }));
      return;
    }
    const body = JSON.parse(raw);
    requests.push({ headers: req.headers, body });
    const n = requests.length;
    const { status = 200, json, delayMs = 0 } = behavior(body, n);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (res.destroyed) return;
    const headers = { 'content-type': 'application/json', 'request-id': `req_fake_${n}` };
    if (status === 200) res.writeHead(200, headers).end(JSON.stringify(json));
    else res.writeHead(status, headers).end(JSON.stringify({ type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message: `fake ${status}` } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    respondWith(fn) { behavior = fn; },
    reset() { requests.length = 0; behavior = defaultReply; },
    close: () => new Promise((r) => server.close(r)),
  };
}

// A well-formed Messages API response whose text proves which question it answered.
export function messageReply(text, { inputTokens = 42, outputTokens = 17, stopReason = 'end_turn', model = 'claude-haiku-5-5', withThinking = false } = {}) {
  return {
    status: 200,
    json: {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model,
      content: [...(withThinking ? [{ type: 'thinking', thinking: '', signature: 'sig' }] : []), ...(text === null ? [] : [{ type: 'text', text }])],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  };
}

function defaultReply(body) {
  const lastUser = body.messages.filter((m) => m.role === 'user').at(-1).content;
  return messageReply(`Fake answer to: ${lastUser}`);
}

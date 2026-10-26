// Part 9: send one typed data part to another agent with the protocol's normal message/send and read
// the typed reply. Used for application conventions (lesson deliveries, session challenges) that start a
// NEW interaction — not task-status callbacks for a task that never existed.
import { randomUUID } from 'node:crypto';
import { Role } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';

const clients = new Map(); // baseUrl → client (re-discovered after any failure)

// Returns { ok: true, value } or { ok: false, outcome: 'not_delivered' | 'uncertain', error }.
// not_delivered: the request certainly didn't reach the agent (connection refused, card unavailable).
// uncertain: it may have been processed (timeout, connection lost mid-request) — reconcile, don't resend blindly.
export async function sendData(baseUrl, { mediaType, value, metadata = {}, contextId = '', timeoutMs = 5000 }) {
  let client = clients.get(baseUrl);
  try {
    if (!client) {
      client = await new ClientFactory().createFromUrl(baseUrl);
      clients.set(baseUrl, client);
    }
  } catch (err) {
    clients.delete(baseUrl);
    return { ok: false, outcome: 'not_delivered', error: describe(err) };
  }
  try {
    const result = await client.sendMessage({
      tenant: '', configuration: undefined, metadata: undefined,
      message: {
        messageId: randomUUID(), contextId, taskId: '', role: Role.ROLE_USER,
        parts: [{ content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType }],
        metadata, extensions: [], referenceTaskIds: [],
      },
    }, { signal: AbortSignal.timeout(timeoutMs) });
    const parts = result.parts ?? result.status?.message?.parts ?? [];
    return { ok: true, value: parts.find((p) => p.content?.$case === 'data')?.content.value ?? null };
  } catch (err) {
    clients.delete(baseUrl);
    const refused = err?.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(err?.message));
    return { ok: false, outcome: refused ? 'not_delivered' : 'uncertain', error: describe(err) };
  }
}

const describe = (err) => (err?.name === 'TimeoutError' ? 'no reply in time' : err?.cause?.code === 'ECONNREFUSED' ? 'connection refused' : String(err?.message ?? err).slice(0, 160));

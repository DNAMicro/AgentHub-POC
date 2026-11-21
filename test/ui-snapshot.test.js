// The UI server's copy of the Hub's state must follow later changes. The Hub sends its full snapshot once, when the
// UI server connects; after that only change events arrive. A page that opens after those events have left the bounded
// history must still be told the current state (2026-11-20: a long-running demo showed every agent "Not registered").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, openStream, chatVia, waitFor, status, stopProcess, hubEntry } from './support/harness.js';

test('a page opened after history was cut still gets the current registry and session states', async () => {
  const stack = await startStack({ hr: true, uiEnv: { UI_HISTORY_LIMIT: '5' } });
  try {
    const first = await status(stack.ui);
    assert.equal(first.topology.specialists.find((s) => s.agentId === 'library').status, 'ready');
    assert.equal(first.sessions?.peoplesoft_session, 'connected', 'the hello carries the MCP session state');

    // A change after the snapshot: the Library signs out (SIGTERM), then enough traffic to push that event out of history.
    await stopProcess(stack.library);
    await waitFor(async () => (await hubEntry(stack.hub, 'library')).status === 'disconnected', { what: 'the Hub sees the Library sign out' });
    const s = await openStream(stack.ui.url);
    await chatVia(stack.ui, s, 'Explain limits');
    await chatVia(stack.ui, s, 'Explain derivatives');
    s.close();

    const late = await openStream(stack.ui.url);
    await waitFor(() => late.replayed, { what: 'replay' });
    assert.ok(late.truncated?.missed > 0, 'the history was cut');
    assert.equal(late.events.filter((e) => e.type === 'registry_status').length, 0, 'the change event is no longer replayed');
    const lib = late.hello.topology.specialists.find((x) => x.agentId === 'library');
    assert.equal(lib.status, 'disconnected', 'the snapshot followed the change');
    assert.equal(late.hello.topology.specialists.find((x) => x.agentId === 'tutor').status, 'ready');
    assert.equal(late.hello.sessions.peoplesoft_session, 'connected');
    late.close();
  } finally {
    stack.kill();
  }
});

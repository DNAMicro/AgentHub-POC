// The MCP session pill follows the real state end to end (HR -> Hub -> UI): connected at startup, unreachable when
// PeopleSoft goes away, connected again when it returns, and never two identical statuses in a row in the UI history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, startPeopleSoft, stopProcess, openStream, waitFor } from './support/harness.js';

test('peoplesoft_session in the UI history changes only on a change, through a PeopleSoft crash and restart', async (t) => {
  const stack = await startStack({ library: false, professor: true, hr: true, hubEnv: { ROUTER_MODE: 'mock' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' } });
  t.after(() => stack.kill());
  const stream = await openStream(stack.ui.url); // opens after startup: the state is replayed once
  t.after(() => stream.close());
  const statuses = () => stream.events.filter((e) => e.type === 'peoplesoft_session' && e.source === 'hr').map((e) => e.data.status);
  await waitFor(() => statuses().includes('connected'), { timeout: 10000, what: 'connected at startup' });
  const port = new URL(stack.peoplesoft.url).port;
  await stopProcess(stack.peoplesoft);
  await waitFor(() => statuses().includes('unreachable'), { timeout: 15000, what: 'unreachable after the crash' });
  stack.peoplesoft = await startPeopleSoft({ PORT: port, PEOPLESOFT_TOKEN: stack.peoplesoftToken, PEOPLESOFT_TEST_HOOKS: '1' });
  await waitFor(() => statuses().at(-1) === 'connected', { timeout: 20000, what: 'connected again' });
  assert.deepEqual(statuses(), ['connected', 'unreachable', 'connected']);
});

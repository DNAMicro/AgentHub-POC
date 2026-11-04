// Part 15 final-review I1: a card closed (New conversation → closeAll) while its handler is still awaiting its
// backend stays closed. form-host must never turn it back into `accepted`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFormHost } from '../src/form-host.js';
import { A2UI_VERSION, WORKFLOWS } from '../src/forms.js';

const WORKFLOW = 'staff-time-off';
const bus = () => ({ events: [], publish(e) { this.events.push(e); }, finished() {} });

test('a card closed during its Submit handler stays closed, even if the handler then says accepted', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const host = createFormHost({
    agentId: 'hr', isEnabled: () => true, emitViz: () => {}, log: () => {},
    workflows: {
      [WORKFLOW]: {
        build: () => [],
        actions: { async submitTimeOff() { await gate; return { status: 'accepted', message: 'Sent.', receipt: { requestId: 'TO-1' } }; } },
      },
    },
  });
  const issueCtx = { contextId: 'ctx-1', taskId: 'task-1', userMessage: { messageId: 'm-1', metadata: {} } };
  const formId = host.issue(issueCtx, bus(), { workflowId: WORKFLOW, intro: 'Check it and submit.' });
  const action = { version: A2UI_VERSION, action: { name: 'submitTimeOff', surfaceId: formId, sourceComponentId: WORKFLOWS[WORKFLOW].actions.submitTimeOff.button, context: {} } };
  const ctx = { contextId: 'ctx-1', taskId: 'task-1', task: { id: 'task-1' }, userMessage: { messageId: 'm-2', metadata: { operationId: 'op-12345678' }, referenceTaskIds: [] } };
  const pending = host.handleAction(ctx, bus(), null, { content: { value: [action] } });
  await new Promise((r) => setImmediate(r));
  assert.equal(host.closeAll('This card was closed when the HR records were reset. Ask again for a new card.'), 1);
  release();
  await pending;
  assert.equal(host.form(formId).state, 'closed', 'the reset closed it; the late answer does not reopen or accept it');
  assert.equal(host.openForm('ctx-1', WORKFLOW), null);
});

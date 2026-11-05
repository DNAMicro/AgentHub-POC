// Startup warm-up of the Faculty->Canvas and HR->PeopleSoft MCP links: connect without any tool call, report the
// session once per change, retry a failed connect until the other process starts. Real stand-in servers; a short
// retry interval is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasLink } from '../src/professor-canvas.js';
import { createPeopleSoftLink } from '../src/hr-peoplesoft.js';
import { startCanvas, startPeopleSoft, unusedPort, stopProcess, waitFor } from './support/harness.js';
import { canvasEnv, newToken } from './support/canvas-fixtures.js';

const recorder = () => {
  const events = [];
  return { events, emit: (type, runId, data) => events.push({ type, runId, data }), statuses: (type) => events.filter((e) => e.type === type).map((e) => e.data.status) };
};
const CASES = [
  { name: 'Canvas', make: createCanvasLink, event: 'canvas_session', start: (token, port) => startCanvas({ PORT: String(port), ...canvasEnv(token) }), tokenless: 'not_configured' },
  { name: 'PeopleSoft', make: createPeopleSoftLink, event: 'peoplesoft_session', start: (token, port) => startPeopleSoft({ PORT: String(port), PEOPLESOFT_TOKEN: token, PEOPLESOFT_TEST_HOOKS: '1' }), tokenless: null },
];

for (const c of CASES) {
  test(`${c.name} link: warm connects to a running server and makes no tool call`, async (t) => {
    const token = newToken();
    const server = await c.start(token, await unusedPort());
    const rec = recorder();
    const link = c.make({ url: server.url, token, emit: rec.emit });
    t.after(async () => { await link.close(); await stopProcess(server); });
    assert.equal(await link.warm(), 'connected');
    assert.deepEqual(rec.statuses(c.event), ['connected']);
    assert.equal(rec.events.some((e) => e.type === 'mcp_call_started'), false);
    assert.equal(link.sessionStatus().status, 'connected'); // what a feed follower connecting later is told
    await link.warm(); // already connected: no second report
    assert.deepEqual(rec.statuses(c.event), ['connected']);
  });

  test(`${c.name} link: warm with no token does nothing on the network`, async () => {
    const rec = recorder();
    const link = c.make({ url: 'http://127.0.0.1:9', token: '', emit: rec.emit });
    assert.equal(await link.warm(), 'not_configured');
    assert.deepEqual(rec.statuses(c.event), c.tokenless ? [c.tokenless] : []);
    await link.close();
  });

  test(`${c.name} link: warm on a closed port says unreachable, then connects once the server starts`, async (t) => {
    const token = newToken();
    const port = await unusedPort();
    const rec = recorder();
    const link = c.make({ url: `http://127.0.0.1:${port}`, token, emit: rec.emit });
    let server = null;
    t.after(async () => { await link.close(); if (server) await stopProcess(server); });
    assert.equal(await link.warm({ retryMs: 150, maxMs: 30000 }), 'unreachable');
    assert.deepEqual(rec.statuses(c.event), ['unreachable']);
    server = await c.start(token, port);
    await waitFor(() => rec.statuses(c.event).includes('connected'), { timeout: 15000 });
    assert.deepEqual(rec.statuses(c.event), ['unreachable', 'connected']); // reported only on a change
  });

  test(`${c.name} link: close() stops the retry timer`, async () => {
    const rec = recorder();
    const link = c.make({ url: 'http://127.0.0.1:9', token: 'x', emit: rec.emit });
    await link.warm({ retryMs: 50, maxMs: 30000 });
    await link.close();
    const n = rec.events.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rec.events.length, n);
  });
}

for (const c of CASES) {
  test(`${c.name} link: a server crash under a warmed link reports unreachable; its restart reports connected again`, async (t) => {
    const token = newToken();
    const port = await unusedPort();
    let server = await c.start(token, port);
    const rec = recorder();
    const link = c.make({ url: server.url, token, emit: rec.emit });
    t.after(async () => { await link.close(); await stopProcess(server); });
    assert.equal(await link.warm({ retryMs: 150, maxMs: 30000 }), 'connected');
    await stopProcess(server);
    await waitFor(() => rec.statuses(c.event).includes('unreachable'), { timeout: 10000, what: `${c.event} unreachable after the crash` });
    server = await c.start(token, port);
    await waitFor(() => rec.statuses(c.event).at(-1) === 'connected', { timeout: 15000, what: `${c.event} connected again` });
    assert.deepEqual(rec.statuses(c.event), ['connected', 'unreachable', 'connected']);
  });
}

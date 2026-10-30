// Part 10: the browser's AG-UI client for the UI server's long-lived event streams. Used by the browser
// bundle (src/browser/ag-ui-entry.js) and by the tests — no DOM code here.
//
// The installed @ag-ui/client 1.0.3 HttpAgent does NOT implement connect(): the base class throws
// AGUIConnectNotImplementedError and connectAgent() swallows it, so events nobody asked for would
// silently never arrive. This subclass overrides connect(). Two sources:
//   - `events`: an Observable of AG-UI events — one channel of the page's single connection
//     (/api/ui/stream; browsers allow only 6 connections per server, so a page holds just one);
//   - `streamUrl`: its own GET stream (/api/ag-ui/stream, /api/ag-ui/professor/stream — tests, other clients).
// Everything it yields still goes through the client's own pipeline (format checks, the run-order
// verifier, state/message application) — so it drops events it already has (by metadata.id) BEFORE the
// verifier sees them. One agent = one subscription = one verifier: on a reconnect the app makes a new
// StreamAgent (fresh dedupe), passing the last event ID; a different bootId (the UI server restarted)
// ends the subscription with `bootChanged` so the app can reset its screen and connect afresh.
import { HttpAgent } from '@ag-ui/client';
import { Observable } from 'rxjs';

// One AG-UI channel of the page's single connection. The client subscribes to an agent's source a moment
// AFTER connectAgent() is called (it awaits its own setup first), so a plain Subject would drop the first
// events — the opening snapshot, hello and the whole history replay. This keeps them until the agent
// subscribes, then passes events straight through.
export function bufferedChannel() {
  let queue = [];
  let done = false;
  let target = null;
  return {
    next(event) { if (target) target.next(event); else queue.push(event); },
    complete() { done = true; if (target) target.complete(); },
    observable: new Observable((subscriber) => {
      target = subscriber;
      for (const event of queue) subscriber.next(event);
      queue = [];
      if (done) subscriber.complete();
      return () => { target = null; };
    }),
  };
}

export class StreamAgent extends HttpAgent {
  constructor({ streamUrl = null, runsUrl, events = null, after = null, bootId = null, signal = null, ...config }) {
    super({ url: runsUrl ?? streamUrl ?? '/', ...config });
    this.streamUrl = streamUrl;
    this.events = events;
    this.after = after; // last AG-UI event ID this tab saw (Last-Event-ID)
    this.bootId = bootId; // the UI server boot that ID belongs to
    this.lastId = after;
    this.bootChanged = false;
    this.seen = new Set();
    this.signal = signal; // aborted when the page is left: the stream then ends quietly (no error)
  }

  // One event from either source: false = stop (the server restarted).
  accept(event, eventId, subscriber) {
    const boot = eventId ? eventId.split(':')[0] : null;
    if (boot && this.bootId && boot !== this.bootId) {
      this.bootChanged = true; // a new server process: its runs mean nothing to this verifier
      subscriber.complete();
      return false;
    }
    if (boot) this.bootId = boot;
    if (eventId) {
      if (this.seen.has(eventId)) return true;
      this.seen.add(eventId);
      if (eventId.includes(':a')) this.lastId = eventId; // shared history IDs (not per-connection)
    }
    subscriber.next(event);
    return true;
  }

  connect() {
    if (this.events) {
      return new Observable((subscriber) => {
        const sub = this.events.subscribe({
          next: (event) => { if (!this.accept(event, event.metadata?.id ?? null, subscriber)) sub?.unsubscribe(); },
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
        return () => sub.unsubscribe();
      });
    }
    return new Observable((subscriber) => {
      const abort = new AbortController();
      this.signal?.addEventListener('abort', () => abort.abort(), { once: true });
      (async () => {
        const res = await fetch(this.streamUrl, { headers: this.after ? { 'Last-Event-ID': this.after } : {}, signal: abort.signal });
        if (!res.ok || !res.body) throw new Error(`AG-UI stream: HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let id = null;
            const data = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('id:')) id = line.slice(3).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            if (!data.length) continue;
            const event = JSON.parse(data.join('\n'));
            if (!this.accept(event, id ?? event.metadata?.id ?? null, subscriber)) { abort.abort(); return; }
          }
        }
        subscriber.complete();
      })().catch((err) => (abort.signal.aborted ? subscriber.complete() : subscriber.error(err)));
      return () => abort.abort();
    });
  }
}

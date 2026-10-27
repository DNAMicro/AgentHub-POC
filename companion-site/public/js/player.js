// A step-through walkthrough of one user action on the step's architecture diagram. Each event lights
// up one component or moves a token along one connection, with a caption. Play / Pause / Replay /
// Previous / Next event; the numbered list beside it is the same walkthrough without motion (and the
// only form it takes when the reader prefers reduced motion). Simulated — never a live call.
import { EDGES, NODES, neutral, pointAlong, renderDiagram } from './diagram.js';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SVG = 'http://www.w3.org/2000/svg';
let uid = 0;

export function createPlayer(root, { state, events, title }) {
  const id = `wt-${++uid}`;
  root.classList.add('player');
  root.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'player-head';
  head.innerHTML = '<span class="sim-badge" title="An illustration of what the code does, played back here. Nothing is sent to any agent or model.">Simulated walkthrough</span>';
  const h = document.createElement('h3');
  h.className = 'player-title';
  h.textContent = title;
  head.prepend(h);

  const frame = document.createElement('div');
  frame.className = 'diagram-frame';
  const svg = document.createElementNS(SVG, 'svg');
  svg.id = `${id}-svg`;
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${title}: architecture diagram; the current event is described in the caption below.`);
  frame.append(svg);
  renderDiagram(svg, neutral(state));

  const caption = document.createElement('p');
  caption.className = 'caption';
  caption.setAttribute('aria-live', 'polite');

  const controls = document.createElement('div');
  controls.className = 'controls';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Walkthrough controls');
  const btn = (label, aria, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = label;
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', fn);
    controls.append(b);
    return b;
  };
  const list = document.createElement('ol');
  list.className = 'event-list';
  list.setAttribute('aria-label', 'Every event in order (the same walkthrough without animation)');
  events.forEach((ev, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'event-jump';
    b.innerHTML = `<strong></strong> <span></span>`;
    b.querySelector('strong').textContent = ev.title;
    b.querySelector('span').textContent = ev.caption;
    b.addEventListener('click', () => { pause(); show(i); });
    li.append(b);
    list.append(li);
  });

  let index = -1;
  let timer = null;
  let raf = null;
  const prevB = btn('<span aria-hidden="true">⏮</span> Prev', 'Previous event', () => { pause(); show(Math.max(0, index - 1)); });
  const playB = btn('<span aria-hidden="true">▶</span> Play', 'Play', () => (timer ? pause() : play()));
  const nextB = btn('Next event <span aria-hidden="true">⏭</span>', 'Next event', () => { pause(); show(Math.min(events.length - 1, index + 1)); });
  const replayB = btn('<span aria-hidden="true">↺</span> Replay', 'Replay from the start', () => { pause(); show(-1); play(); });
  const counter = document.createElement('span');
  counter.className = 'counter';
  controls.append(counter);

  function clear() {
    cancelAnimationFrame(raf);
    svg.querySelectorAll('.active, .lit').forEach((n) => n.classList.remove('active', 'lit'));
    svg.querySelector('.pulses')?.replaceChildren();
  }
  function show(i) {
    clear();
    index = i;
    list.querySelectorAll('li').forEach((li, k) => li.toggleAttribute('aria-current', k === i));
    counter.textContent = i < 0 ? `${events.length} events` : `Event ${i + 1} of ${events.length}`;
    if (i < 0) { caption.textContent = 'Press Play, or step through with Next event.'; return; }
    const ev = events[i];
    caption.innerHTML = '<strong></strong> ';
    caption.querySelector('strong').textContent = `${i + 1}. ${ev.title}.`;
    caption.append(ev.caption);
    if (ev.payload) {
      const code = document.createElement('code');
      code.className = 'payload';
      code.textContent = ev.payload;
      caption.append(' ', code);
    }
    const [kind, ref] = ev.at.split(':');
    if (kind === 'node') svg.querySelector(`.node[data-id="${ref}"]`)?.classList.add('active');
    else {
      const e = EDGES[ref];
      svg.querySelectorAll(`[data-id="${ref}"]`).forEach((n) => n.classList.add('active'));
      const [a, b] = ev.reverse ? [e.to, e.from] : [e.from, e.to];
      svg.querySelector(`.node[data-id="${a}"]`)?.classList.add('lit');
      svg.querySelector(`.node[data-id="${b}"]`)?.classList.add('lit');
      const dot = document.createElementNS(SVG, 'circle');
      dot.setAttribute('r', 9);
      dot.setAttribute('class', `token k-${e.kind}`);
      svg.querySelector('.pulses').append(dot);
      const place = (t) => { const [x, y] = pointAlong(ref, t, ev.reverse); dot.setAttribute('cx', x); dot.setAttribute('cy', y); };
      if (reduced()) place(1);
      else {
        const start = performance.now();
        const step = (now) => { const t = Math.min(1, (now - start) / 1000); place(t); if (t < 1) raf = requestAnimationFrame(step); };
        raf = requestAnimationFrame(step);
      }
    }
  }
  function play() {
    if (index >= events.length - 1) show(-1);
    playB.innerHTML = '<span aria-hidden="true">⏸</span> Pause';
    playB.setAttribute('aria-label', 'Pause');
    const tick = () => {
      if (index >= events.length - 1) { pause(); return; }
      show(index + 1);
      timer = setTimeout(tick, reduced() ? 3200 : 2800);
    };
    tick();
  }
  function pause() {
    clearTimeout(timer);
    timer = null;
    playB.innerHTML = '<span aria-hidden="true">▶</span> Play';
    playB.setAttribute('aria-label', 'Play');
  }
  root.addEventListener('keydown', (e) => {
    if (e.key === ' ' && e.target === root) { e.preventDefault(); timer ? pause() : play(); }
  });

  const stage = document.createElement('div');
  stage.className = 'player-stage';
  stage.append(frame, controls, caption);
  root.append(head, stage, list);
  show(-1);
  return { pause, destroy: () => { pause(); clear(); } };
}

// For the check script and tests: every event must point at something that exists in the state.
export function validateEvents(state, events) {
  const bad = [];
  for (const ev of events) {
    const [kind, ref] = ev.at.split(':');
    if (kind === 'node' ? !(ref in NODES) || !state.nodes[ref] : !(ref in EDGES) || !state.edges[ref]) bad.push(ev.at);
  }
  return bad;
}

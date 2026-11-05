// Readable chat text (owner, 2026-11-05: "many of the messages … are hard to read because there is no proper
// separation and formatting"). Turns a reply's plain text into paragraphs and real lists, built with
// textContent only (never innerHTML): a blank line starts a new paragraph, lines starting with "- ", "• " or
// "* " become a bulleted list, lines starting with "1. " / "1) " a numbered list. Stray Markdown the screen
// can't show (**bold**, __bold__, "# Heading") is unwrapped to its words. With `split`, a long paragraph a
// model wrote as one block is broken into short paragraphs at sentence ends (2–3 sentences each), so a
// 600-character answer is not a wall of text. A person's own words are never split (`split` is off for them).

const BULLET = /^\s*(?:[-•*])\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,2})[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
// Words ending with a period that don't end a sentence.
const ABBREV = /(?:^|\s)(?:Dr|Mr|Mrs|Ms|Prof|St|No|vs|etc|e\.g|i\.e|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\.$/i;
const SPLIT_OVER = 320; // characters: a paragraph longer than this is broken up when `split` is on
const TARGET = 220; // aim for paragraphs about this long

const unwrap = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`\n]+)`/g, '$1');

export function sentences(text) {
  const out = [];
  let start = 0;
  const re = /[.!?]["”’)]?(?=\s+["“(]?[A-Z0-9])/g;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (ABBREV.test(text.slice(start, m.index + 1))) continue;
    out.push(text.slice(start, end).trim());
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

function splitLong(par) {
  if (par.length <= SPLIT_OVER || par.includes('\n')) return [par];
  const parts = sentences(par);
  if (parts.length < 3) return [par];
  const out = [];
  let cur = '';
  for (const s of parts) {
    if (cur && cur.length + s.length + 1 > TARGET && cur.length >= 80) { out.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) {
    // Never leave a one-line scrap at the end: a short tail joins the paragraph before it.
    if (out.length && cur.length < 60) out[out.length - 1] += ` ${cur}`;
    else out.push(cur);
  }
  return out;
}

// Pure: text -> [{ type: 'p', text } | { type: 'ul', items } | { type: 'ol', start, items }]
export function blocksOf(text, { split = false } = {}) {
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join('\n');
    for (const t of split ? splitLong(joined) : [joined]) blocks.push({ type: 'p', text: t });
    para = [];
  };
  const flushList = () => { if (list) blocks.push(list); list = null; };
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = unwrap(raw);
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      flushPara();
      const type = b ? 'ul' : 'ol';
      if (!list || list.type !== type) { flushList(); list = type === 'ol' ? { type, start: Number(n[1]), items: [] } : { type, items: [] }; }
      list.items.push((b ? b[1] : n[2]).trim());
      continue;
    }
    if (!line.trim()) { flushList(); flushPara(); continue; }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; } // an indented continuation
    flushList();
    const h = HEADING.exec(line);
    para.push(h ? h[1] : line);
  }
  flushList();
  flushPara();
  return blocks;
}

// A short label that opens a paragraph or list item ("Product:", "Worked example:") is drawn in bold so the
// reader can scan the reply. 1–4 words, letters first; never a time ("10:00") or a whole sentence.
// In a list the labels may be a little longer (up to 6 words), but are bolded only when EVERY item has one,
// so a list is never half bold.
const LABEL = /^([A-Z][A-Za-z'’"&/()-]*(?: [A-Za-z'’"&/()-]+){0,5}):\s+(?=\S)/;
export function labelOf(text, { maxWords = 4 } = {}) {
  const m = LABEL.exec(text);
  return m && m[1].split(' ').length <= maxWords && m[1].length <= 48 ? m[1] : null;
}
function fill(node, text, label = labelOf(text)) {
  if (!label) { node.textContent = text; return node; }
  const b = document.createElement('b');
  b.className = 'rt-label';
  b.textContent = `${label}:`;
  node.append(b, ` ${text.slice(label.length + 1).trimStart()}`);
  return node;
}

// Fills `container` (a div.msg-text) with the blocks. One plain paragraph stays as plain text, so existing
// checks that read the bubble's textContent see exactly the same words.
export function renderRichText(container, text, opts) {
  const blocks = blocksOf(text, opts);
  container.classList.remove('rich');
  if (blocks.length <= 1 && (!blocks[0] || blocks[0].type === 'p')) { container.textContent = blocks[0]?.text ?? ''; return container; }
  container.classList.add('rich');
  container.replaceChildren(...blocks.map((b) => {
    if (b.type === 'p') return fill(document.createElement('p'), b.text);
    const list = document.createElement(b.type);
    if (b.type === 'ol' && b.start !== 1) list.start = b.start;
    const labels = b.items.map((item) => labelOf(item, { maxWords: 6 }));
    const bold = labels.every(Boolean);
    b.items.forEach((item, i) => list.append(fill(document.createElement('li'), item, bold ? labels[i] : null)));
    return list;
  }));
  return container;
}

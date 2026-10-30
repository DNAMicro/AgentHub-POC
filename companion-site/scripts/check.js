// Structural checks for the companion site (run: npm run check). Prints each check and exits non-zero
// on any failure. Content checks only — rendering is checked in a browser.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCH, PAGES, STEPS } from '../public/js/content.js';
import { EDGES, NODES } from '../public/js/diagram.js';
import { validateEvents } from '../public/js/player.js';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(site, '..');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

// Page budget: one introduction, at most two pages per step.
const LAST = STEPS.length;
check('first page is the introduction', PAGES[0]?.type === 'intro');
check('exactly one introduction', PAGES.filter((p) => p.type === 'intro').length === 1);
check('at most two pages per step plus the introduction', PAGES.length <= 2 * LAST + 1, `${PAGES.length} pages`);
for (let n = 1; n <= LAST; n++) {
  const pages = PAGES.filter((p) => p.step === n);
  check(`step ${n}: has page A, at most two pages`, pages.some((p) => p.type === 'A') && pages.length <= 2 && pages.every((p) => ['A', 'B'].includes(p.type)), pages.map((p) => p.type).join(','));
}
check('pages are in step order', PAGES.slice(1).every((p, i, a) => i === 0 || a[i - 1].step < p.step || (a[i - 1].step === p.step && a[i - 1].type === 'A' && p.type === 'B')));
check('steps numbered 1…N, one diagram snapshot each', STEPS.length >= 9 && STEPS.every((s, i) => s.n === i + 1) && Object.keys(ARCH).length === LAST);

// Architecture continuity: one diagram, known pieces only, edges connect present nodes.
for (let n = 1; n <= LAST; n++) {
  const a = ARCH[n];
  const unknown = [...Object.keys(a.nodes).filter((id) => !NODES[id]), ...Object.keys(a.edges).filter((id) => !EDGES[id]), ...(a.modified ?? []).filter((id) => !(id in a.nodes) && !(id in a.edges))];
  check(`step ${n}: architecture uses known components only`, !unknown.length, unknown.join(', '));
  const dangling = Object.keys(a.edges).filter((id) => !a.nodes[EDGES[id].from] || !a.nodes[EDGES[id].to]);
  check(`step ${n}: every connection joins two present components`, !dangling.length, dangling.join(', '));
}

// Walkthroughs: every event points at something on that step's diagram; text present.
for (const p of PAGES.filter((x) => x.type === 'B')) {
  const bad = validateEvents(ARCH[p.step], p.walk.events);
  check(`step ${p.step}B: walkthrough events exist on the diagram`, !bad.length, bad.join(', '));
  check(`step ${p.step}B: walkthrough has 4–14 captioned events`, p.walk.events.length >= 4 && p.walk.events.length <= 14 && p.walk.events.every((e) => e.title && e.caption));
  check(`step ${p.step}B: code example is short (≤14 lines)`, !p.code || p.code.text.split('\n').length <= 14, `${p.code?.text.split('\n').length ?? 0} lines`);
  check(`step ${p.step}B: test command and expectation`, p.test?.cmd && p.test?.expect);
}

// Screenshots exist; sources point at real files; commits exist in git history.
const shots = PAGES.flatMap((p) => (p.shot ? [p.shot] : []));
for (const s of shots) check(`screenshot exists: ${s.src}`, existsSync(join(site, 'public', s.src)));
const paths = new Set();
const commits = new Set();
for (const p of PAGES) for (const s of p.sources ?? []) {
  for (const m of s.matchAll(/`([\w./-]+\.(?:js|md|json|html|css))`/g)) paths.add(m[1]);
  for (const m of s.matchAll(/\b([0-9a-f]{7})\b/g)) commits.add(m[1]);
}
for (const s of STEPS) for (const c of s.commits) commits.add(c);
// A file a later step removed (e.g. Step 3's student-form.js) counts if git history has it.
const inHistory = (x) => execFileSync('git', ['log', '--all', '--format=%h', '-1', '--', x], { cwd: repo, encoding: 'utf8' }).trim() !== '';
const missing = [...paths].filter((x) => !existsSync(join(repo, x)) && !inHistory(x));
check(`every cited source file exists, now or in git history (${paths.size})`, !missing.length, missing.join(', '));
const known = new Set(execFileSync('git', ['log', '--format=%h'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean).map((h) => h.slice(0, 7)));
const unknownCommits = [...commits].filter((c) => !known.has(c));
check(`every cited commit exists in git history (${commits.size})`, !unknownCommits.length, unknownCommits.join(', '));

// Locally bundled: no external scripts, styles or images.
const pub = join(site, 'public');
const files = readdirSync(pub, { recursive: true }).filter((f) => /\.(html|css|js)$/.test(f));
const external = files.filter((f) => /(src|href)=["']https?:|url\(\s*["']?https?:|import .* from ["']https?:/.test(readFileSync(join(pub, f), 'utf8')));
check('no external assets', !external.length, external.join(', '));
// No secrets-looking strings in the site.
const secrets = files.filter((f) => /sk-ant-[\w-]{10,}|ANTHROPIC_API_KEY\s*=\s*\S+/.test(readFileSync(join(pub, f), 'utf8')));
check('no key-like strings', !secrets.length, secrets.join(', '));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

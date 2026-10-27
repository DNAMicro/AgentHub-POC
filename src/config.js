// Part 7: connection configuration for the four agents, with startup validation.
//
// Each agent reads an optional JSON file (STUDENT_CONFIG / HUB_CONFIG / TUTOR_CONFIG / LIBRARY_CONFIG;
// examples in config/*.example.json) over built-in localhost defaults. A few environment variables
// override single values so tests can use free ports. Invalid configuration throws a clear error —
// nothing silently falls back to direct Student-to-specialist routing.
//
// Secrets never live here: model credentials are named by environment variable (apiKeyEnv) and read
// only by the server process that needs them.
import { readFileSync } from 'node:fs';
import { DEFAULT_KEY_ENV, DEFAULT_MODEL, MODELS } from './models.js';

const ID = /^[a-z][a-z0-9-]{1,40}$/;
const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

export class ConfigError extends Error {
  constructor(role, problems) {
    super(`Invalid ${role} configuration:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

function readFile(envVar) {
  const path = process.env[envVar];
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(envVar, [`Could not read ${path}: ${err.message}`]);
  }
}
const merge = (base, over) => {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' ? merge(out[k], v) : v;
  return out;
};
const env = (name) => (process.env[name] === undefined || process.env[name] === '' ? undefined : process.env[name]);
const num = (v) => (v === undefined ? undefined : Number(v));
const card = (base) => `${base}/.well-known/agent-card.json`;
const check = (problems, ok, message) => { if (!ok) problems.push(message); };
const positive = (v) => Number.isInteger(v) && v > 0;

// Each model-using agent picks its own model (from the checked list in src/models.js — no fallback to
// another model) and names the environment variable that holds its own key. <ROLE>_MODEL overrides.
const DEFAULT_MODEL_CFG = { name: DEFAULT_MODEL, apiKeyEnv: DEFAULT_KEY_ENV };
function modelProblems(p, cfg, overrideVar) {
  if (env(overrideVar)) cfg.model.name = env(overrideVar);
  check(p, Object.hasOwn(MODELS, cfg.model?.name ?? ''), `model.name "${cfg.model?.name}" is not one of the supported models: ${Object.keys(MODELS).join(', ')}${env(overrideVar) ? ` (set by ${overrideVar})` : ''}.`);
  check(p, /^[A-Z][A-Z0-9_]*$/.test(cfg.model?.apiKeyEnv ?? ''), 'model.apiKeyEnv must name an environment variable (the key itself never goes in this file).');
  check(p, !Object.keys(cfg.model ?? {}).some((k) => /key$/i.test(k) && k !== 'apiKeyEnv'), 'Put the API key in the environment, not in the configuration file.');
}

// ---- Student ------------------------------------------------------------------------------------

export function loadStudentConfig() {
  const defaults = {
    agentId: 'student-alex',
    displayName: 'Student Agent',
    university: { name: 'California State University Fullerton', relationship: 'Enrolled student (fictional demo identity)', hubUrl: 'http://127.0.0.1:41243' },
    timeouts: { chatMs: 60000, formActionMs: 8000 },
    model: DEFAULT_MODEL_CFG, // the Student's own model (clarifying and capability choice; STUDENT_MODE)
  };
  const cfg = merge(defaults, readFile('STUDENT_CONFIG'));
  if (env('HUB_URL')) cfg.university.hubUrl = env('HUB_URL');
  if (env('CHAT_TIMEOUT_MS')) cfg.timeouts.chatMs = num(env('CHAT_TIMEOUT_MS'));
  if (env('SUBMIT_TIMEOUT_MS')) cfg.timeouts.formActionMs = num(env('SUBMIT_TIMEOUT_MS'));
  cfg.university.cardUrl ??= card(cfg.university.hubUrl);
  const p = [];
  check(p, ID.test(cfg.agentId ?? ''), 'agentId must be a lowercase id like "student-alex".');
  check(p, typeof cfg.university?.name === 'string' && cfg.university.name.length > 0, 'university.name is required.');
  check(p, LOCAL_URL.test(cfg.university?.hubUrl ?? ''), 'university.hubUrl must be a localhost URL like http://127.0.0.1:41243 (localhost-only spike).');
  check(p, cfg.university.cardUrl === card(cfg.university.hubUrl), 'university.cardUrl must be the Hub’s own /.well-known/agent-card.json.');
  check(p, positive(cfg.timeouts?.chatMs) && positive(cfg.timeouts?.formActionMs), 'timeouts.chatMs and timeouts.formActionMs must be positive integers (ms).');
  for (const forbidden of ['tutorUrl', 'libraryUrl', 'specialists', 'peers']) check(p, !(forbidden in cfg), `"${forbidden}" is not allowed: the Student connects only to the university Hub.`);
  modelProblems(p, cfg, 'STUDENT_MODEL');
  if (p.length) throw new ConfigError('Student', p);
  return cfg;
}

// ---- Tutor / Library / Professor ---------------------------------------------------------------------

const SPECIALISTS = {
  tutor: { port: 41241, displayName: 'Tutor Agent', file: 'TUTOR_CONFIG', model: 'TUTOR_MODEL', label: 'Tutor' },
  library: { port: 41242, displayName: 'Library Agent', file: 'LIBRARY_CONFIG', model: 'LIBRARY_MODEL', label: 'Library' },
  // Part 9: the Marketing 101 Professor (a private specialist behind the Hub, like the others).
  professor: { port: 41244, displayName: 'Marketing 101 Professor', file: 'PROFESSOR_CONFIG', model: 'PROFESSOR_MODEL', label: 'Professor' },
};

export function loadSpecialistConfig(role) {
  const spec = SPECIALISTS[role];
  if (!spec) throw new ConfigError('Specialist', [`Unknown specialist role "${role}".`]);
  const port = spec.port;
  const defaults = {
    agentId: role,
    displayName: spec.displayName,
    hub: { url: 'http://127.0.0.1:41243' },
    enabled: true,
    heartbeatIntervalMs: 3000,
    model: DEFAULT_MODEL_CFG,
  };
  const cfg = merge(defaults, readFile(spec.file));
  if (env('HUB_URL')) cfg.hub.url = env('HUB_URL');
  if (env('HEARTBEAT_INTERVAL_MS')) cfg.heartbeatIntervalMs = num(env('HEARTBEAT_INTERVAL_MS'));
  if (env('SPECIALIST_ENABLED')) cfg.enabled = env('SPECIALIST_ENABLED') !== '0';
  cfg.defaultPort = port;
  const p = [];
  check(p, cfg.agentId === role, `agentId must be "${role}" (the identity the Hub allowlists).`);
  check(p, LOCAL_URL.test(cfg.hub?.url ?? ''), 'hub.url must be a localhost URL like http://127.0.0.1:41243.');
  check(p, typeof cfg.enabled === 'boolean', 'enabled must be true or false.');
  check(p, positive(cfg.heartbeatIntervalMs) && cfg.heartbeatIntervalMs >= 200, 'heartbeatIntervalMs must be an integer ≥ 200.');
  modelProblems(p, cfg, spec.model);
  if (p.length) throw new ConfigError(spec.label, p);
  return cfg;
}

// ---- Hub ----------------------------------------------------------------------------------------

export function loadHubConfig() {
  const defaults = {
    agentId: 'csuf-hub',
    name: 'California State University Fullerton',
    description: 'University assistance front door (fictional local demo): routes student requests to the university’s internal tutoring and library services. Not an official university service.',
    peers: [
      { agentId: 'tutor', expectedName: 'Tutor Agent', displayName: 'Tutor Agent', baseUrl: 'http://127.0.0.1:41241' },
      { agentId: 'library', expectedName: 'Library Agent', displayName: 'Library Agent', baseUrl: 'http://127.0.0.1:41242' },
      { agentId: 'professor', expectedName: 'Marketing 101 Professor', displayName: 'Marketing 101 Professor', baseUrl: 'http://127.0.0.1:41244' },
    ],
    destinations: {
      // name/tags/examples are PUBLIC: they become the Hub card's capability skills (no worker names or URLs).
      tutoring: {
        worker: 'tutor', name: 'Tutoring', description: 'Academic tutoring and in-person tutoring requests. Subjects come from the Tutor’s enabled skills.',
        tags: ['tutor', 'tutoring', 'explain', 'homework', 'calculus', 'derivative', 'integral', 'limit', 'algebra', 'math'],
        examples: ['Explain the derivative of x squared', 'I want to book an in-person tutoring session'],
      },
      library: {
        worker: 'library', name: 'Library services', description: 'Library services: hours, borrowing, renewals, returns, finding resources, group study rooms.',
        tags: ['library', 'book', 'borrow', 'renew', 'return', 'loan', 'due', 'overdue', 'hours', 'study room', 'reserve'],
        examples: ['How do I renew a library book?', 'I want to reserve a group study room'],
      },
      // Part 9: the Marketing 101 course (a fictional class) — questions go to its professor.
      marketing: {
        worker: 'professor', name: 'Marketing 101', description: 'Marketing 101 (a fictional introductory course): marketing concepts, course lessons, worked examples, checking your understanding, and questions about the course itself (homework, assignments, the professor’s messages).',
        tags: ['marketing', 'marketing 101', 'segmentation', 'targeting', 'positioning', 'branding', 'pricing', 'promotion', 'customer value', 'lesson'],
        examples: ['What is the difference between segmentation and targeting?', 'Can you explain the lesson about customer value?'],
      },
    },
    students: ['student-alex', 'student-sam'],
    // Part 9: display names (fictional), so a professor can tag “@alex” or write “Sam” in chat.
    studentNames: { 'student-alex': 'Alex Student', 'student-sam': 'Sam Student' },
    // Part 9 (trusted data): where the Hub may deliver to each student's own agent (its inbound A2A
    // endpoint, served by the UI server), and who teaches and is enrolled in each course.
    studentEndpoints: { 'student-alex': 'http://127.0.0.1:4444' },
    // Sam Student (fictional) is enrolled but has no Student agent in this demo: posts to "all" queue for them.
    courses: { 'mkt-101': { title: 'Marketing 101', professor: 'professor', enrolled: ['student-alex', 'student-sam'] } },
    heartbeatExpiryMs: 10000,
    timeouts: { dispatchMs: 60000, formActionMs: 8000, cardFetchMs: 3000 },
    model: DEFAULT_MODEL_CFG,
  };
  const cfg = merge(defaults, readFile('HUB_CONFIG'));
  for (const peer of cfg.peers) {
    const override = env(`${peer.agentId.toUpperCase()}_URL`);
    if (override) peer.baseUrl = override;
  }
  if (env('HEARTBEAT_EXPIRY_MS')) cfg.heartbeatExpiryMs = num(env('HEARTBEAT_EXPIRY_MS'));
  if (env('HUB_DISPATCH_TIMEOUT_MS')) cfg.timeouts.dispatchMs = num(env('HUB_DISPATCH_TIMEOUT_MS'));
  if (env('HUB_FORM_TIMEOUT_MS')) cfg.timeouts.formActionMs = num(env('HUB_FORM_TIMEOUT_MS'));
  if (env('HUB_STUDENTS')) cfg.students = env('HUB_STUDENTS').split(',');
  if (env('STUDENT_URL')) cfg.studentEndpoints = { ...cfg.studentEndpoints, [cfg.students[0]]: env('STUDENT_URL') };
  const p = [];
  check(p, ID.test(cfg.agentId ?? ''), 'agentId must be a lowercase id like "csuf-hub".');
  check(p, typeof cfg.name === 'string' && cfg.name.length > 0, 'name (the public university name) is required.');
  check(p, Array.isArray(cfg.peers) && cfg.peers.length > 0, 'peers (the allowlisted specialists) must be a non-empty list.');
  const ids = new Set();
  for (const peer of cfg.peers ?? []) {
    check(p, ID.test(peer.agentId ?? '') && !ids.has(peer.agentId), `peer agentId "${peer.agentId}" must be a unique lowercase id.`);
    ids.add(peer.agentId);
    check(p, LOCAL_URL.test(peer.baseUrl ?? ''), `peer ${peer.agentId}: baseUrl must be a localhost URL (got "${peer.baseUrl}").`);
    check(p, typeof peer.expectedName === 'string' && peer.expectedName.length > 0, `peer ${peer.agentId}: expectedName (the name its card must carry) is required.`);
  }
  const workers = new Set();
  for (const [dest, d] of Object.entries(cfg.destinations ?? {})) {
    check(p, ID.test(dest), `destination "${dest}" must be a lowercase id.`);
    check(p, ids.has(d?.worker), `destination "${dest}": worker "${d?.worker}" is not an allowlisted peer.`);
    check(p, !workers.has(d?.worker), `destination "${dest}": worker "${d?.worker}" is already assigned to another destination.`);
    workers.add(d?.worker);
    check(p, d?.tags === undefined || (Array.isArray(d.tags) && d.tags.every((t) => typeof t === 'string' && t.trim())), `destination "${dest}": tags must be a list of words.`);
    check(p, d?.examples === undefined || (Array.isArray(d.examples) && d.examples.every((t) => typeof t === 'string')), `destination "${dest}": examples must be a list of sentences.`);
  }
  check(p, Object.keys(cfg.destinations ?? {}).length > 0, 'at least one destination is required.');
  check(p, Array.isArray(cfg.students) && cfg.students.every((s) => ID.test(s)), 'students must be a list of student ids.');
  for (const [sid, url] of Object.entries(cfg.studentEndpoints ?? {})) {
    check(p, cfg.students.includes(sid), `studentEndpoints: "${sid}" is not a configured student.`);
    check(p, LOCAL_URL.test(url ?? ''), `studentEndpoints.${sid} must be a localhost URL (got "${url}").`);
  }
  for (const [courseId, c] of Object.entries(cfg.courses ?? {})) {
    check(p, ID.test(courseId), `course "${courseId}" must be a lowercase id.`);
    check(p, typeof c?.title === 'string' && c.title.length > 0, `course ${courseId}: title is required.`);
    check(p, ids.has(c?.professor), `course ${courseId}: professor "${c?.professor}" is not an allowlisted peer.`);
    check(p, Array.isArray(c?.enrolled) && c.enrolled.every((s) => cfg.students.includes(s)), `course ${courseId}: enrolled must list configured students.`);
  }
  check(p, positive(cfg.heartbeatExpiryMs) && cfg.heartbeatExpiryMs >= 500, 'heartbeatExpiryMs must be an integer ≥ 500.');
  for (const k of ['dispatchMs', 'formActionMs', 'cardFetchMs']) check(p, positive(cfg.timeouts?.[k]), `timeouts.${k} must be a positive integer (ms).`);
  modelProblems(p, cfg, 'HUB_MODEL');
  if (p.length) throw new ConfigError('Hub', p);
  // Derived trusted endpoints (never taken from a card, message, or model output).
  cfg.peers = cfg.peers.map((peer) => ({
    ...peer, rpcUrl: `${peer.baseUrl}/a2a/jsonrpc`, cardUrl: card(peer.baseUrl),
    settingsUrl: `${peer.baseUrl}/settings/skills`, vizUrl: `${peer.baseUrl}/viz/events`,
  }));
  return cfg;
}

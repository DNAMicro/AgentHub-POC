// One skill configuration per agent is the single source for three things:
//   1. the advertised Agent Card skills (standard A2A AgentSkill fields only),
//   2. the routing metadata Student reads from that card (incl. the scope extension below),
//   3. the agent's runtime policy (scope + private answer content).
//
// Skill kinds:
//   answer — answered by the agent's model from the skill's saved "answer content" (and, for the
//            Tutor, its own subject knowledge). The content is private: it never goes on the card.
//   form   — an agent's built-in A2UI workflow form (Tutor: in-person tutoring requests; Library:
//            group study-room booking), handled by code. Reserved ID per agent; it can
//            be enabled/disabled and re-described, but not added twice or given to another agent.
import { createHash } from 'node:crypto';

// Scope boundaries aren't A2A AgentSkill fields, so they travel in a documented, non-required
// A2A extension (capabilities.extensions). This is this project's convention, not part of A2A.
export const SCOPE_EXTENSION_URI = 'urn:a2a-spike:skill-scope:v1';
// Media type of our application-level "agent card changed" notification (also not part of A2A).
export const CARD_CHANGED_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-card-changed+json';

const SKILL_KEYS = ['id', 'kind', 'enabled', 'name', 'description', 'tags', 'examples', 'scope', 'knowledge'];
const SKILL_ID = /^[a-z0-9][a-z0-9-]{1,48}$/;
export const SKILL_LIMITS = { skills: 12, name: 80, description: 500, tags: 10, tag: 30, examples: 6, example: 200, scopeItems: 12, scopeItem: 160, knowledge: 6000 };

const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const cleanList = (v) => v.map((s) => s.trim()).filter(Boolean);

// rules: what this agent supports.
//   { answer: { knowledge: 'required' | 'optional' }, form?: { id: 'in-person-tutoring-request' } }
// Returns { ok: true, config } (normalized) or { ok: false, errors: [{ path, message }] }.
export function validateSkillConfig(input, rules) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: [{ path: '', message: 'Configuration must be an object.' }] };
  const extraTop = Object.keys(input).filter((k) => k !== 'skills');
  if (extraTop.length) err('', `Unexpected field(s): ${extraTop.join(', ')}. Only skills can be edited here.`);
  if (!Array.isArray(input.skills)) return { ok: false, errors: [...errors, { path: 'skills', message: 'skills must be a list.' }] };
  if (input.skills.length > SKILL_LIMITS.skills) err('skills', `At most ${SKILL_LIMITS.skills} skills.`);

  const seenIds = new Set();
  // Built-in workflow skills: rules.form = { id } (one) or { ids: [...] } (Part 8: several).
  const formIds = formIdsOf(rules);
  const skills = input.skills.map((raw, i) => {
    const p = `skills[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      err(p, 'Each skill must be an object.');
      return null;
    }
    const extra = Object.keys(raw).filter((k) => !SKILL_KEYS.includes(k));
    if (extra.length) err(p, `Unexpected field(s): ${extra.join(', ')}.`);
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!SKILL_ID.test(id)) err(`${p}.id`, 'Skill ID must be 2–49 lowercase letters, digits, or dashes.');
    else if (seenIds.has(id)) err(`${p}.id`, `Another skill already uses the ID "${id}".`);
    seenIds.add(id);

    const kind = raw.kind ?? 'answer';
    if (kind === 'form') {
      if (!formIds.length) err(`${p}.kind`, 'This agent has no built-in form.');
      else if (!formIds.includes(id)) err(`${p}.kind`, formIds.length === 1 ? `Only the built-in "${formIds[0]}" skill can be a form.` : `Only the built-in ${formIds.map((f) => `"${f}"`).join(' and ')} skills can be forms.`);
    } else if (kind !== 'answer') {
      err(`${p}.kind`, 'Unknown skill kind.');
    } else if (formIds.includes(id)) {
      err(`${p}.id`, `"${id}" is reserved for the built-in form.`);
    }
    if (typeof raw.enabled !== 'boolean') err(`${p}.enabled`, 'enabled must be true or false.');
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || name.length > SKILL_LIMITS.name) err(`${p}.name`, `Name is required (max ${SKILL_LIMITS.name} characters).`);
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (!description || description.length > SKILL_LIMITS.description) err(`${p}.description`, `Description is required (max ${SKILL_LIMITS.description} characters).`);
    const list = (key, max, maxLen, value) => {
      if (!isStringList(value)) {
        err(`${p}.${key}`, `${key} must be a list of text items.`);
        return [];
      }
      const items = cleanList(value);
      if (items.length > max) err(`${p}.${key}`, `At most ${max} items.`);
      if (items.some((s) => s.length > maxLen)) err(`${p}.${key}`, `Each item is limited to ${maxLen} characters.`);
      return items;
    };
    const tags = list('tags', SKILL_LIMITS.tags, SKILL_LIMITS.tag, raw.tags ?? []);
    const examples = list('examples', SKILL_LIMITS.examples, SKILL_LIMITS.example, raw.examples ?? []);
    const scope = raw.scope ?? {};
    if (typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).some((k) => k !== 'allowed' && k !== 'excluded')) err(`${p}.scope`, 'scope must have only "allowed" and "excluded" lists.');
    const allowed = list('scope.allowed', SKILL_LIMITS.scopeItems, SKILL_LIMITS.scopeItem, scope.allowed ?? []);
    const excluded = list('scope.excluded', SKILL_LIMITS.scopeItems, SKILL_LIMITS.scopeItem, scope.excluded ?? []);
    if (raw.enabled && !allowed.length) err(`${p}.scope.allowed`, 'Add at least one line describing what this skill covers.');

    const knowledge = typeof raw.knowledge === 'string' ? raw.knowledge.trim() : raw.knowledge == null ? '' : null;
    if (knowledge === null) err(`${p}.knowledge`, 'Answer content must be text.');
    else if (knowledge.length > SKILL_LIMITS.knowledge) err(`${p}.knowledge`, `Answer content is limited to ${SKILL_LIMITS.knowledge} characters.`);
    else if (kind === 'answer' && raw.enabled && rules.answer.knowledge === 'required' && !knowledge) {
      err(`${p}.knowledge`, 'Add the answer content this skill answers from — the agent has no other source.');
    } else if (kind === 'form' && knowledge) err(`${p}.knowledge`, 'The built-in form has no answer content.');
    return { id, kind, enabled: raw.enabled, name, description, tags, examples, scope: { allowed, excluded }, knowledge: knowledge ?? '' };
  });
  if (formIds.length && skills.filter((s) => s?.kind === 'form').length > formIds.length) err('skills', 'Each built-in form can appear only once.');
  return errors.length ? { ok: false, errors } : { ok: true, config: { skills } };
}

export const formIdsOf = (rules) => (rules.form ? rules.form.ids ?? [rules.form.id] : []);

export const configHash = (config) => createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);

// (1) Agent Card skills — standard AgentSkill fields only, enabled skills only. No answer content.
export const buildCardSkills = (config) =>
  config.skills.filter((s) => s.enabled).map((s) => ({
    id: s.id, name: s.name, description: s.description, tags: s.tags, examples: s.examples,
    inputModes: [], outputModes: [], securityRequirements: [],
  }));

// (2) The documented scope extension carried in capabilities.extensions.
export const buildScopeExtension = (config, revision) => ({
  uri: SCOPE_EXTENSION_URI,
  description: 'A2A Spike convention (not part of A2A): per-skill allowed scope and exclusions, plus the skill-configuration revision.',
  required: false,
  params: {
    revision,
    skills: Object.fromEntries(config.skills.filter((s) => s.enabled).map((s) => [s.id, { allowed: s.scope.allowed, excluded: s.scope.excluded }])),
  },
});

// (3) Runtime policy — the receiving agent's own, authoritative view of what it may do now.
export function policyFromConfig(config, revision) {
  const enabled = config.skills.filter((s) => s.enabled);
  return Object.freeze({
    revision,
    skills: enabled.map((s) => ({ id: s.id, kind: s.kind, name: s.name, description: s.description, tags: s.tags, allowed: s.scope.allowed, excluded: s.scope.excluded, knowledge: s.knowledge })),
    kinds: new Set(enabled.map((s) => s.kind)),
  });
}

// Plain-text scope description for model instructions, built from the same policy.
export function scopeText(skills) {
  return skills.map((s) => [
    `- ${s.name} (skill ${s.id}): ${s.description}`,
    `  Allowed: ${s.allowed.join('; ') || '(none)'}`,
    `  Excluded: ${s.excluded.join('; ') || '(none listed)'}`,
  ].join('\n')).join('\n');
}

// Saved answer content, per skill, for model instructions (only skills that have some).
export function knowledgeText(skills) {
  return skills.filter((s) => s.knowledge).map((s) => `### ${s.name} (skill ${s.id})\n${s.knowledge}`).join('\n\n');
}

// Skill settings for a service agent (Tutor or Library): the single skill configuration,
// its atomic save, the settings HTTP API (local developer controls), and the A2A
// "agent_card_changed" notification — sent to the University Hub (Part 7), never to the Student.
//
// The settings API edits skills only. Identity, endpoint URLs, security and protocol
// capabilities are not part of the configuration and cannot be changed here.
import express from 'express';
import { sameOriginGuard } from './local-guard.js';
import {
  SCOPE_EXTENSION_URI, buildCardSkills, buildScopeExtension, configHash, formIdsOf,
  policyFromConfig, validateSkillConfig,
} from './skills.js';

// notify({ revision, reason }) → { notificationId, outcome, detail }: the Hub link's card-change notice.
export function createSkillService({ agentId, agentName, defaults, rules, card, emit, log, notify }) {
  const initial = validateSkillConfig(defaults, rules);
  if (!initial.ok) throw new Error(`Invalid default skills for ${agentId}: ${JSON.stringify(initial.errors)}`);
  const testedHash = configHash(initial.config); // the defaults are what the automated tests cover

  let config = initial.config;
  let revision = 1;
  let policy = policyFromConfig(config, revision);
  let etag = null;
  let lastNotification = null;
  let selfCardUrl = null;
  let port = null;

  // Write the configuration into the live card object the SDK serves (synchronous: atomic in JS).
  function applyToCard(target, cfg, rev) {
    target.skills = buildCardSkills(cfg);
    const others = (target.capabilities.extensions ?? []).filter((e) => e.uri !== SCOPE_EXTENSION_URI);
    target.capabilities.extensions = [...others, buildScopeExtension(cfg, rev)];
  }
  applyToCard(card, config, revision);

  async function refreshOwnEtag() {
    // The SDK serves the card with a content-hash ETag; read it back so the UI can show it.
    try {
      const res = await fetch(selfCardUrl, { signal: AbortSignal.timeout(2000) });
      etag = res.headers.get('etag');
    } catch {
      etag = null;
    }
    return etag;
  }

  // One attempt, no retry loop. The Hub re-fetches cards when an agent registers, so a notice that
  // can't be delivered now is reported as pending, not resent forever.
  async function notifyHub(reason) {
    const sent = await notify({ revision, reason });
    lastNotification = { ...sent, revision, reason, at: new Date().toISOString() };
    log('card change notification', { notificationId: sent.notificationId, revision, reason, outcome: sent.outcome });
    emit('card_notification', lastNotification);
    return lastNotification;
  }

  const describe = () => ({
    agentId, agentName, revision, etag, config,
    // What the editor needs to know: is answer content required, and which skill is the built-in form.
    rules: { knowledge: rules.answer.knowledge, builtInFormId: formIdsOf(rules)[0] ?? null, builtInFormIds: formIdsOf(rules) },
    matchesTestedDefault: configHash(config) === testedHash,
    lastNotification,
    note: 'Local developer controls. Edits skills only — not identity, endpoints, security, or protocol settings.',
  });

  function previewCard(cfg, rev) {
    const copy = structuredClone(card);
    applyToCard(copy, cfg, rev);
    return copy;
  }

  function router() {
    const r = express.Router();
    r.use(express.json({ limit: '32kb' }));
    r.use((req, res, next) => (req.method === 'GET' ? next() : sameOriginGuard(port)(req, res, next)));
    r.get('/settings/skills', (req, res) => res.json(describe()));
    r.post('/settings/skills/preview', (req, res) => {
      const result = validateSkillConfig(req.body?.config, rules);
      if (!result.ok) return res.status(400).json({ errors: result.errors });
      res.json({ card: previewCard(result.config, revision + 1), matchesTestedDefault: configHash(result.config) === testedHash });
    });
    r.put('/settings/skills', async (req, res) => {
      if (req.body?.baseRevision !== revision) {
        return res.status(409).json({ error: `The skills changed since you opened them (now revision ${revision}). Reload and try again.`, revision });
      }
      const result = validateSkillConfig(req.body?.config, rules);
      if (!result.ok) return res.status(400).json({ errors: result.errors });
      // Atomic swap: configuration, runtime policy, and served card change together.
      revision += 1;
      config = result.config;
      policy = policyFromConfig(config, revision);
      applyToCard(card, config, revision);
      await refreshOwnEtag();
      const saved = { revision, etag, enabledSkills: policy.skills.map((s) => s.id), matchesTestedDefault: configHash(config) === testedHash };
      log('skills saved', saved);
      emit('skills_saved', saved);
      res.json({ ...saved, card });
      notifyHub('skills_saved'); // reported separately via card_notification
    });
    return r;
  }

  return {
    policy: () => policy,
    revision: () => revision,
    describe,
    router,
    notifyHub,
    async started(actualPort, cardUrl) {
      port = actualPort;
      selfCardUrl = cardUrl;
      await refreshOwnEtag();
      // No startup notice: registering with the Hub makes it fetch the current card.
    },
  };
}

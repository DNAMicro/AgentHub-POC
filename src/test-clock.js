// Test hook: PROFESSOR_NOW pins "now" for the Faculty agent and the UI server's quiz check. Read only when
// PROFESSOR_TEST_HOOKS=1 and strictly ISO; anything else is ignored (production never sees it).
export function professorNow(env = process.env) {
  if (env.PROFESSOR_TEST_HOOKS !== '1' || !env.PROFESSOR_NOW) return null;
  const raw = env.PROFESSOR_NOW;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) throw new Error('PROFESSOR_NOW must be an ISO date-time such as 2026-11-04T20:00:00Z.');
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new Error('PROFESSOR_NOW must be an ISO date-time such as 2026-11-04T20:00:00Z.');
  return t;
}
export const nowFn = (env = process.env) => { const t = professorNow(env); return () => new Date(t ?? Date.now()); };

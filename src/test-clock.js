// Test hook: <NAME>_NOW pins "now" for one process, read only when <NAME>_TEST_HOOKS=1 and strictly ISO; anything
// else is ignored (production never sees it). PROFESSOR_NOW: the Faculty agent and the UI server's quiz check.
// HR_NOW: the HR Agent's reading of "Friday" / "tomorrow", so tests do not depend on the day they run.
export function pinnedNow(name, env = process.env) {
  const key = `${name}_NOW`;
  if (env[`${name}_TEST_HOOKS`] !== '1' || !env[key]) return null;
  const raw = env[key];
  const problem = `${key} must be an ISO date-time such as 2026-11-04T20:00:00Z.`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) throw new Error(problem);
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new Error(problem);
  return t;
}
export const professorNow = (env = process.env) => pinnedNow('PROFESSOR', env);
export const nowFn = (env = process.env, name = 'PROFESSOR') => { const t = pinnedNow(name, env); return () => new Date(t ?? Date.now()); };

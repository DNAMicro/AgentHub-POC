// Part 9: a tiny persisted JSON document (one per process and file). Written atomically — temp file +
// rename — so a crash never leaves a half-written file. Used for the Professor's outbox, the Hub's lesson
// ledger and the Student's inbox. A local demo store, not a database: one writer per file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function createJsonStore(file, initial) {
  let state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : structuredClone(initial);
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1));
    renameSync(tmp, file);
  };
  if (!existsSync(file)) save();
  return {
    get: () => state,
    // Mutate and persist in one synchronous step (no await in between, so two callers can't interleave).
    update(fn) {
      const result = fn(state);
      save();
      return result;
    },
    file,
  };
}

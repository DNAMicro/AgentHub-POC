// Before a talk: puts the demo's (fictional) book loans back to their starting state, so Step 8 of the
// live walkthrough has a loan to renew (renewals run out). Run it while the Library is stopped — the
// Library holds loans in memory and would write its own copy back.
//   npm run demo:reset-loans
import { copyFile, access } from 'node:fs/promises';
import { connect } from 'node:net';

function listening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

export async function resetLoans({ from = 'data/library-loans.before-e2e.json', to = process.env.LOAN_STORE_FILE ?? 'data/library-loans.json', libraryPort = 41242 } = {}) {
  if (await listening(libraryPort)) return { ok: false, reason: 'library_running' };
  try { await access(from); } catch { return { ok: false, reason: 'missing_source' }; }
  await copyFile(from, to);
  return { ok: true, to };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const from = 'data/library-loans.before-e2e.json';
  const result = await resetLoans({ from });
  if (result.ok) console.log(`Loans reset from ${from} to ${result.to}`);
  else {
    console.error(result.reason === 'library_running'
      ? 'Not reset: the Library is running on 127.0.0.1:41242. Stop the demo first.'
      : `Not reset: ${from} is missing.`);
    process.exitCode = 1;
  }
}

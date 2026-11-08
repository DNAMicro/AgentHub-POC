// Manage who can sign in to the demo (Part 18). Passwords are typed, never shown, and only their hash is saved.
//   npm run access:add <name>      add or change a password (asked twice on a terminal; else first stdin line)
//   npm run access:remove <name>
//   npm run access:list
// File: config/access.json (git-ignored), or AGENTHUB_ACCESS_FILE.
import { createInterface } from 'node:readline';
import { DEFAULT_ACCESS_FILE, MIN_PASSWORD, hashPassword, loadAccess, normalUser, saveAccess, AccessError } from '../src/access.js';

const file = process.env.AGENTHUB_ACCESS_FILE || DEFAULT_ACCESS_FILE;
const [cmd, name] = process.argv.slice(2);
const fail = (msg) => { console.error(msg); process.exit(1); };

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); }; // show the question, never the typing
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}
async function firstStdinLine() {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) { rl.close(); return line; }
  return '';
}

let users;
try { users = loadAccess(file, { missingOk: true }); } catch (err) { fail(err instanceof AccessError ? err.message : 'error'); }

if (cmd === 'list') {
  console.log(users.length ? users.map((u) => u.username).join('\n') : '(no accounts)');
} else if (cmd === 'add') {
  const u = normalUser(name);
  if (!u) fail('Usage: npm run access:add <name>  (letters, digits, . _ - ; up to 32)');
  let pw;
  if (process.stdin.isTTY) {
    pw = await askHidden(`Password for ${u}: `);
    const again = await askHidden('Same password again: ');
    if (pw !== again) fail('The two passwords are different. Nothing changed.');
  } else pw = await firstStdinLine();
  if (String(pw).length < MIN_PASSWORD) fail(`Use at least ${MIN_PASSWORD} characters. Nothing changed.`);
  const { salt, hash } = await hashPassword(pw);
  const next = users.filter((x) => x.username !== u).concat({ username: u, salt, hash });
  saveAccess(file, next);
  console.log(`${users.some((x) => x.username === u) ? 'Changed the password for' : 'Added'} ${u}. A running demo picks it up within a few seconds.`);
} else if (cmd === 'remove') {
  const u = normalUser(name);
  if (!u || !users.some((x) => x.username === u)) fail('No such account.');
  saveAccess(file, users.filter((x) => x.username !== u));
  console.log(`Removed ${u}. A running demo signs them out within a few seconds.`);
} else {
  fail('Usage: npm run access:add|access:remove <name>, or npm run access:list');
}

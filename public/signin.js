// Part 18 sign-in page helpers. The form works without this file; it only adds Show/Hide, the Caps Lock hint
// and “Signing in…” while the server checks. textContent only.
const pw = document.getElementById('password');
const show = document.getElementById('show');
const caps = document.getElementById('caps');
const form = document.getElementById('signin-form');
const submit = document.getElementById('submit');

show.hidden = false;
show.addEventListener('click', () => {
  const visible = pw.type === 'text';
  pw.type = visible ? 'password' : 'text';
  show.textContent = visible ? 'Show' : 'Hide';
  show.setAttribute('aria-pressed', String(!visible));
  pw.focus();
});
const capsCheck = (e) => { if (e.getModifierState) caps.hidden = !e.getModifierState('CapsLock'); };
pw.addEventListener('keydown', capsCheck);
pw.addEventListener('keyup', capsCheck);
pw.addEventListener('blur', () => { caps.hidden = true; });

form.addEventListener('submit', () => {
  if (submit.disabled) return;
  setTimeout(() => { // after the browser has collected the form
    submit.disabled = true;
    const spin = document.createElement('span');
    spin.className = 'spin';
    submit.replaceChildren(spin, document.createTextNode('Signing in…'));
  }, 0);
});

const first = document.getElementById('username').value ? pw : document.getElementById('username');
if (!submit.disabled) first.focus();

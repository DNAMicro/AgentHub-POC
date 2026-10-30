// Step 11 · Fill from chat — Alex opens a renewal form, types the date in the chat, and presses Renew
scenes.push({
  n: 11,
  title: 'Fill from chat',
  async run() {
    // (a) A fresh conversation (New conversation also puts the sample loans back), then the renewal form.
    let form = null;
    await moment('Alex asks to renew the calculus book; the Library sends a renewal form', async () => {
      await tab('conversation');
      const fresh = left.locator('#new-conversation');
      if (await fresh.isVisible().catch(() => false)) { await click(fresh); await sleep(2000); }
      await ask('I need to renew my calculus book');
      const reply = items.nth((await items.count()) - 1); // pinned: items.last() moves to newer chat items
      if (await seen(reply.locator('input[type="date"]'), 30000)) form = reply;
      else problems.push('Step 11 · the Library answered without a renewal form (nothing to fill)');
    });
    if (!form) return;

    // (b) The date typed in the chat lands in the open form — nothing is sent to the university.
    let filled = false;
    await moment('Alex types the date in the chat; it fills the form', async () => {
      await ask('november 20');
      filled = (await form.locator('input[type="date"]').first().inputValue().catch(() => '')) === '2026-11-20';
      if (!filled) problems.push('Step 11 · “november 20” did not fill the date');
    });
    if (!filled) return;

    // (c) The final click is Alex's.
    await moment('Alex presses Renew', async () => {
      const before = await items.count();
      await click(form.getByRole('button').filter({ hasText: /renew/i }).first());
      await settle(before - 1);
      if (!(await seen(items.last().filter({ hasText: /Renewed|now due/i }), 30000))) problems.push('Step 11 · no renewal receipt');
    });
  },
});

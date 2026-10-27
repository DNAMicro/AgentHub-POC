// Step 2 · Browser monitor — a fresh chat, one question, then the reply's A2A ids
scenes.push({
  n: 2,
  title: 'Browser monitor',
  async run() {
    const log = left.locator('#student-log');
    const items = log.locator(':scope > li');

    if (opts.fresh && (await left.locator('#new-conversation').isVisible().catch(() => false))) {
      await moment('starts a fresh conversation', async () => {
        const btn = left.locator('#new-conversation');
        await moveTo(btn);
        await click(btn);
        await pause(1500);
      });
    }

    let replyAt = -1;
    // A plain subject question, so it goes all the way Student → Hub → Tutor (a vague one is only
    // answered by the Student's own clarifying question, and the strip shows a single hop).
    await moment('asks a calculus question, strip lights up', async () => {
      const before = await items.count();
      await typeInto(left.locator('#message'), 'What is a derivative, in one sentence?');
      await press('Enter');
      await moveTo(left.locator('.timeline-panel'));
      await settle(before);
      replyAt = (await items.count()) - 1;
    });
    if (replyAt < 0) return;

    const reply = items.nth(replyAt);
    await moment('opens the reply’s A2A ids', async () => {
      const ids = reply.locator(':scope > details > summary').first();
      await moveTo(ids);
      await click(ids);
      await pause(1500);
    });
  },
});

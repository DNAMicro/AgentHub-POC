// Step 8 · Generated loan UI — asks to renew a borrowed book, sets the return date by keyboard, renews, then opens the inspector
scenes.push({
  n: 8,
  title: 'Generated loan UI',
  async run() {
    let reply;
    let date;
    await moment('asks to renew a borrowed library book', async () => {
      if (opts.fresh) await freshConversation();
      reply = await ask('I want to renew my borrowed library book Calculus: Early Transcendentals — let me pick the new return date');
      date = reply.locator('input[type="date"]').first();
      // Bring the generated date picker into view, so the moment shows the screen the person will act on.
      if (await seen(date, 15000)) await moveTo(date);
    });
    if (await seen(date, 1000)) {
      await moment('sets the return date by keyboard, then renews', async () => {
        // Chromium puts the caret wherever the mouse clicked inside the date box; stepping left reaches the month part.
        await click(date);
        for (let i = 0; i < 6; i++) await press('ArrowLeft');
        // Type the field's min in the locale's part order (en-US: month, day, year); the value check below decides.
        const min = await date.getAttribute('min');
        const order = await left.evaluate(() =>
          new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
            .formatToParts(new Date(2026, 9, 27)).map((p) => p.type).filter((t) => t !== 'literal'));
        const [y, m, d] = min.split('-');
        const parts = { year: y, month: m, day: d };
        for (const part of order) for (const ch of parts[part]) await press(ch);
        // Only renew when the picker really holds the min date; otherwise stop on the generated screen.
        if ((await date.inputValue()) !== min) return;
        const before = await items.count();
        await click(reply.getByRole('button').filter({ hasText: /renew/i }).first());
        await settle(before);
      });
    } else {
      await moment('the model answered in words', async () => {
        await moveTo(reply);
      });
    }
    await moment('opens the generated UI inspector in Agent activity', async () => {
      await tab('activity');
      await moveTo(left.locator('section.inspector'));
    });
    await tab('conversation');
  },
});

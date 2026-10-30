// Step 10 · AG-UI — the same screen, now fed by AG-UI events: Alex asks, then reloads, and the conversation comes back
scenes.push({
  n: 10,
  title: 'AG-UI',
  async run() {
    // (a) A question as AG-UI run input; the reply arrives as an AG-UI run (the Topology popup still animates
    // from the monitoring stream).
    let answered = false;
    await moment('Alex asks; the reply arrives as an AG-UI run', async () => {
      await tab('conversation');
      const reply = await ask('What is a limit, in one sentence?');
      answered = await seen(reply.filter({ hasText: /limit/i }), 60000);
      if (!answered) problems.push('Step 10 · no reply about limits arrived');
    });
    if (!answered) return;

    // (b) A reload rebuilds the conversation from the AG-UI stream's replay — exactly as it was.
    await moment('Alex reloads; the conversation comes back unchanged', async () => {
      const before = await items.count();
      await left.reload();
      await sleep(3000);
      const back = await seen(left.locator('#student-log > li').filter({ hasText: 'What is a limit, in one sentence?' }), 15000);
      const after = await left.locator('#student-log > li').count();
      if (!back || after !== before) problems.push(`Step 10 · after the reload the chat had ${after} items (before: ${before})`);
    });
  },
});

// Step 1 · A2A connectivity — asks a simple question, then shows the real A2A messages in Agent activity
scenes.push({
  n: 1,
  title: 'A2A connectivity',
  async run() {
    await moment('asks a simple question', async () => {
      await tab('conversation');
      await ask('Hello! Can you help me with calculus?');
    });
    await moment('shows the A2A messages', async () => {
      await tab('activity');
      await moveTo(left.locator('section.console[data-agent="tutor"]'));
      await pause(900);
      await moveTo(left.locator('section.console[data-agent="hub"]'));
    });
    await moment('back to the conversation', async () => {
      await tab('conversation');
      await moveTo(items.last());
    });
  },
});

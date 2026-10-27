// Step 4 · Haiku tutor — a real answer from Claude Haiku 5.5, then a follow-up that needs the history
scenes.push({
  n: 4,
  title: 'Haiku tutor',
  async run() {
    const items = left.locator('#student-log > li');

    await moment('asks for the chain rule, Haiku answers over A2A', async () => {
      await ask('Can you explain the chain rule with one quick example?');
      await moveTo(items.last()); // bring the whole answer into view, not just its question
    });

    await moment('a follow-up uses the conversation’s history', async () => {
      await ask('Can you give me an example of that with a sine function?');
      await moveTo(items.last());
    });
  },
});

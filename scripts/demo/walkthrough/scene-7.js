// Step 7 · Hub and topology — asks a homework question, answers the clarifying question, then shows the Hub's console
scenes.push({
  n: 7,
  title: 'Hub and topology',
  async run() {
    let r;
    await moment('asks an unclear homework question', async () => {
      r = await ask('Can you help me with my homework?');
    });
    if (await isQuestion(r)) {
      await moment('answers the clarifying question', async () => {
        r = await ask('It’s for my calculus class — derivatives.');
      });
    }
    await moment('opens the Hub’s console in Agent activity', async () => {
      await tab('activity');
      await moveTo(left.locator('section.console[data-agent="hub"]'));
    });
    await tab('conversation');
  },
});

// Step 16 · Canvas quiz — Dr. Dabirian asks for a quiz, picks a taught topic, edits a question, approves it (saved in
// Canvas, unpublished), publishes it, and Alex gets a notice. Topology (right window) shows the two MCP calls to Canvas.
scenes.push({
  n: 16,
  title: 'Canvas quiz',
  async run() {
    const log = left.locator('#prof-log');
    const card = log.locator('.quiz-card');
    const lms = log.locator('.lms-card');

    // (a) The request. No topic is named, so the assistant lists the topics already taught, as buttons.
    let chips = false;
    await moment('Dr. Dabirian asks the assistant for a quiz; it lists the topics already taught', async () => {
      await tab('professor');
      await typeInto(left.locator('#prof-message'), '@assistant create a quiz for Marketing 351');
      await press('Enter');
      chips = await seen(log.locator('.tchip:not([disabled])'), 90000);
      if (chips) await moveTo(log.locator('.tchip:not([disabled])').first());
      else problems.push('Step 16 · the assistant did not list the topics (it may have answered in words or asked something else)');
    });
    if (!chips) return;

    // (b) He picks Topic 8; the AI drafts the questions on one card (nothing is in Canvas yet).
    let drafted = false;
    await moment('He taps Topic 8; the AI drafts the quiz on one card', async () => {
      const chip = log.locator('.tchip[data-topic="8"]:not([disabled])');
      if (!(await seen(chip, 2000))) { problems.push('Step 16 · the Topic 8 button is not available today'); return; }
      await click(chip);
      drafted = await seen(card.locator('.q-list > .q'), 120000);
      if (drafted) await moveTo(card.locator('.q-slip').first());
      else problems.push('Step 16 · no draft card within 2 minutes (the model may have answered in words)');
    });
    if (!drafted) return;

    // (c) He edits the second question; the card keeps his change (review B8: the review step is visible).
    let edited = false;
    await moment('He edits a question; his change stays on the card', async () => {
      const second = card.locator('.q-list > .q').nth(1);
      await click(second.locator('[data-act="edit"]'));
      const box = card.locator('.q-list > .q.editing textarea');
      if (!(await seen(box, 5000))) { problems.push('Step 16 · the edit row did not open'); return; }
      await click(box);
      await press('End');
      await typeHere(' Choose the best answer.');
      await click(card.locator('.q-list > .q').nth(1).locator('[data-act="done"]'));
      edited = await seen(card.locator('.q-tag', { hasText: 'Edited by you' }), 5000);
      if (!edited) problems.push('Step 16 · the question was not tagged “Edited by you”');
    });

    // (d) Approve: Faculty's AI picks the Canvas tool, Canvas saves the quiz unpublished.
    let saved = false;
    await moment('He approves; Canvas saves it as an unpublished quiz (watch the right window)', async () => {
      const approve = card.locator('[data-act="approve"]');
      if (!(await approve.isEnabled().catch(() => false))) { problems.push('Step 16 · Approve is disabled (the check line names why)'); return; }
      await click(approve);
      saved = await seen(lms.filter({ hasText: /Saved in Canvas as a draft/ }), 120000);
      if (saved) {
        await moveTo(lms.first());
        // Review B8: the confirmation counts his edit — only if the edit really happened.
        if (edited && !(await seen(lms.filter({ hasText: /1 edited by you/ }), 5000))) problems.push('Step 16 · the Canvas confirmation did not count his edit');
      } else problems.push('Step 16 · Canvas did not confirm the save (the card shows the reason)');
    });
    if (!saved) return;

    // (e) Publish: the second Canvas call, then the students are notified.
    let published = false;
    await moment('He publishes; Canvas opens the quiz and the students are notified', async () => {
      const publish = lms.locator('[data-act="publish"]');
      if (!(await seen(publish, 5000))) { problems.push('Step 16 · no Publish button on the Canvas card'); return; }
      await click(publish);
      published = await seen(lms.filter({ hasText: /Published/ }), 120000);
      if (!published) problems.push('Step 16 · Canvas did not confirm the publish');
    });
    if (!published) return;

    // (f) Alex's screen: a notice only, nothing to press.
    await moment('Alex gets a notice; the quiz itself is taken in Canvas', async () => {
      await tab('conversation');
      const notice = left.locator('#student-log .quiz-notice').last();
      if (await seen(notice, 60000)) await moveTo(notice);
      else problems.push('Step 16 · the quiz notice did not reach Alex within a minute');
    });
  },
});

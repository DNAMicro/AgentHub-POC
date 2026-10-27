// Step 9 · Professor — the professor posts to the class, Alex replies, and the professor offers meeting times
scenes.push({
  n: 9,
  title: 'Professor',
  async run() {
    // (a) The professor posts a lesson through the course assistant, then leaves for the student's screen.
    // The toast only appears while the Professor view is hidden, so the professor tab is left at once and the
    // lesson is awaited on the Conversation tab, where the audience sees it arrive unprompted.
    let arrived = false;
    let lessonCard = 0; // index of this lesson's card in the professor's chat (its new card is appended last)
    await moment('professor posts a lesson, it arrives at the student', async () => {
      await tab('professor');
      const box = left.locator('#prof-message');
      lessonCard = await left.locator('#prof-log li.post-card').count();
      const lessonsBefore = await left.locator('#lesson-list > li').count();
      await typeInto(box, '@assistant write a short lesson for the whole class on the 4 Ps of marketing, with one coffee-shop example');
      await press('Enter');
      await tab('conversation');
      const toast = left.locator('#toasts .toast').last();
      arrived = await seen(toast, 120000);
      // Fallback: no toast (for example it was missed), but the inbox gained this lesson.
      if (!arrived) arrived = (await left.locator('#lesson-list > li').count()) > lessonsBefore;
      if (!arrived) problems.push('Step 9 · the lesson did not reach Alex within 2 minutes');
    });
    if (!arrived) return;

    // (b) Alex opens the lesson: the toast's View button, or the inbox if the toast is not there.
    let open = false;
    await moment('Alex opens the lesson', async () => {
      const toastView = left.locator('#toasts .toast').last().getByRole('button', { name: /View/ });
      if (await seen(toastView, 1000)) {
        await click(toastView);
      } else {
        const toggle = left.locator('#inbox-toggle');
        if (await seen(toggle, 10000)) await click(toggle);
        const view = left.locator('#lesson-list li button', { hasText: 'View lesson' }).first();
        if (await seen(view, 5000)) await click(view);
      }
      open = await seen(left.locator('#lesson-dialog[open]'), 5000);
    });
    if (!open) return;

    // (c) A follow-up about the lesson, routed by the lesson's delivery record; the professor answers.
    let answered = false;
    await moment('Alex asks a follow-up about the lesson, the professor answers', async () => {
      await click(left.locator('#lesson-ask'));
      await pause(500);
      const answer = await ask('Could you give me the same idea for a small bookstore?');
      // ask() returns the newest chat item; it is an answer only if it isn't Alex's own message.
      const head = ((await answer.locator('.msg-dir').first().textContent().catch(() => '')) ?? '').trim();
      answered = head !== '' && !/^Sent to /.test(head);
      if (!answered) problems.push('Step 9 · the professor did not answer the follow-up');
    });
    if (!answered) return;

    // (d) Back on the professor's side: Alex's state on the lesson, then a direct message to Alex.
    let sentToAlex = false;
    const lessonState = left.locator('#prof-log li.post-card').nth(lessonCard).locator('.per-student li[data-tone="ok"]', { hasText: 'Alex' });
    await moment('the professor sees Alex has opened the lesson', async () => {
      await tab('professor');
      const opened = lessonState.filter({ hasText: 'Opened' });
      if (await seen(opened, 30000)) await moveTo(opened); // scroll the result into view for the screenshot
    });
    await moment('the professor writes to Alex directly, it is delivered', async () => {
      const box = left.locator('#prof-message');
      await typeInto(box, '@al');
      await pause(800);
      await press('Tab');
      await typeInto(box, 'Can you send me your draft by Friday?');
      await pause(500);
      await press('Enter');
      const line = left.locator('#prof-log li', { hasText: 'draft by Friday' }).filter({ hasText: 'Delivered' }).last();
      sentToAlex = await seen(line, 120000);
      if (sentToAlex) await moveTo(line);
    });
    if (!sentToAlex) return;

    // (e) Alex taps ↩ Reply on the professor's message and answers; the reply goes back to the professor only.
    let replied = false;
    await moment('Alex taps ↩ Reply on the professor’s message and answers', async () => {
      await tab('conversation');
      const replyButton = left.locator('#student-log li.incoming-message', { hasText: 'draft by Friday' }).locator('.reply-action').last();
      if (!(await seen(replyButton, 30000))) return;
      await click(replyButton);
      await pause(400);
      await ask('Yes — I’ll send it Thursday evening.');
      replied = true;
    });
    if (!replied) return;

    // (e, second result) The professor’s chat shows Alex’s reply, relayed by the Hub (no model involved).
    let relayed = false;
    await moment('the professor’s chat shows Alex’s reply', async () => {
      await tab('professor');
      const line = left.locator('#prof-log li.student-reply', { hasText: 'Thursday evening' }).last();
      relayed = await seen(line, 120000);
      if (relayed) await moveTo(line);
    });
    if (!relayed) return;

    // (f) @assistant offers Alex two times; the assistant takes the times only from the professor’s words.
    let offered = false;
    await moment('the course assistant offers Alex two meeting times', async () => {
      await tab('professor');
      const box = left.locator('#prof-message');
      await typeInto(box, '@assistant offer @alex meeting times Wednesday 2:00 pm or Thursday 10:00 am');
      await pause(500);
      await press('Enter');
      const offerCard = left.locator('#prof-log li.post-card', { hasText: 'Pick the time that works' }).last();
      const delivered = offerCard.locator('.per-student li[data-tone="ok"]', { hasText: 'Alex' });
      offered = await seen(delivered, 120000);
      if (offered) await moveTo(offerCard);
    });
    if (!offered) return;

    // (g) Alex picks the first time; the professor books it and the offer shows the choice.
    await moment('Alex picks a time, the professor confirms the booking', async () => {
      await tab('conversation');
      const offer = left.locator('#student-log li[data-meeting]').last();
      const slot = offer.locator('.meeting-times .slot').first();
      if (!(await seen(slot, 30000))) return;
      await click(slot);
      await seen(offer.locator('.slot[aria-pressed="true"]'), 120000);
    });
  },
});

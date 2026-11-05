// Step 17 · CHRS roster — Dr. Dabirian asks to see his class roster (one look-only card of 25), then tells everyone about a
// change. The Hub asks CHRS for the class list and makes one delivery per student; Alex gets it in the Conversation.
// Topology (right window) shows Hub -> CHRS and CHRS -> its student records.
scenes.push({
  n: 17,
  title: 'CHRS class roster',
  async run() {
    const log = left.locator('#prof-log');
    const card = log.locator('.roster-card');

    // (a) The roster request: recognised in code, answered by CHRS from the student records.
    let shown = false;
    await moment('Dr. Dabirian asks to see his class roster; CHRS answers from the student records', async () => {
      await tab('professor');
      await typeInto(left.locator('#prof-message'), 'show me my class roster');
      await press('Enter');
      shown = await seen(card.locator('table.roster tbody tr'), 90000);
      if (shown) await moveTo(card.last());
      else problems.push('Step 17 · no roster card appeared (CHRS may be down, or the reply was in words)');
    });
    if (!shown) return;

    // (b) What is on the card: the real count, not a guess.
    await moment('The card shows his 25 students, look only', async () => {
      const rows = await card.last().locator('table.roster tbody tr').count();
      if (rows !== 25) problems.push(`Step 17 · the roster card shows ${rows} rows, expected 25`);
      else await moveTo(card.last().locator('.cr-grid-title'));
    });

    // (c) Notify everyone: the class list comes from CHRS, one delivery per student.
    let sent = false;
    await moment('He says “notify everyone …”; the Hub asks CHRS who is in the class (watch the right window)', async () => {
      await typeInto(left.locator('#prof-message'), 'notify everyone that the midterm review session moves to Thursday');
      await press('Enter');
      sent = await seen(log.locator('.sent-post .dsum'), 90000);
      if (sent) await moveTo(log.locator('.sent-post .dsum').last());
      else problems.push('Step 17 · the notice did not go out within 90 seconds (CHRS may be down; the chat says why)');
    });
    if (!sent) return;

    await moment('One delivery per student: Alex has it, the others are not online yet', async () => {
      const pills = await log.locator('.sent-post .dsum .pill').last().textContent().catch(() => '');
      const text = (await log.locator('.sent-post').last().textContent()) ?? '';
      if (!/Sent to all 25 students/.test(await log.textContent())) problems.push('Step 17 · the chat did not say “Sent to all 25 students”');
      if (!/Delivered to \d+/.test(text)) problems.push(`Step 17 · the delivery summary is not there (${String(pills).slice(0, 60)})`);
      await click(log.locator('.sent-post').last().locator('details.dlist summary'));
      await moveTo(log.locator('.sent-post').last().locator('details.dlist'));
      await click(log.locator('.sent-post').last().locator('details.dlist summary'));
    });

    // (d) Alex's screen: the same words, from Dr. Dabirian.
    await moment('Alex sees the notice in the Conversation', async () => {
      await tab('conversation');
      const notice = left.locator('#student-log').getByText('midterm review session', { exact: false }).last();
      if (await seen(notice, 60000)) await moveTo(notice);
      else problems.push('Step 17 · the notice did not reach Alex within a minute');
    });
  },
});

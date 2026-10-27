// Step 5 · Routing, skills, scope — ask the Library, get one declined, add a café line to its hours skill, ask again, then take the line back out
scenes.push({
  n: 5,
  title: 'Routing, skills, scope',
  async run() {
    const LINE = 'The library café opens at 7:30 am on weekdays.';
    const dialog = left.locator('#skills-dialog');
    // The Library's skill whose answer content holds the opening hours (id `library-hours`, src/library-fixture.js).
    const hoursCard = () => dialog.locator('.skill-card:has(.skill-title:text-is("Library hours"))');
    const openEditor = async () => {
      await tab('activity');
      await click(left.locator('section.console[data-agent="library"] .gear'));
      await dialog.waitFor({ state: 'visible', timeout: 15000 });
      const card = hoursCard();
      if ((await card.getAttribute('data-open')) !== 'true') await click(card.locator('.skill-toggle'));
      return card;
    };
    const save = async () => {
      await click(left.locator('#skills-save'));
      await dialog.waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
      await pause(1000);
    };

    await moment('asks when the library closes on Sunday — the Library answers', async () => {
      await ask('What time does the library close on Sunday?');
    });

    await moment('asks for physics — declined, nothing enabled covers it', async () => {
      await ask('Can you explain Newton’s second law of motion?');
    });

    const card = await openEditor().catch(() => null);
    if (!card) return;
    await moment('types the café line at the end of the hours skill (not saved yet)', async () => {
      const area = card.locator('textarea[name="knowledge"]');
      await click(area);
      await press('Meta+ArrowDown');
      await press('Enter');
      await typeHere(LINE);
      await pause(800);
    });

    // Once saved, the café line is in the running Library. It must come out again whatever happens next
    // (a skipped step, a failed question): the removal runs in `finally`, and a failure is reported loudly.
    let saved = false;
    let removed = false;
    const removeLine = async () => {
      const again = await openEditor();
      const area = again.locator('textarea[name="knowledge"]');
      await click(area);
      // Only remove text when the added line is really the last line, so nothing else can be deleted.
      if (!(await area.inputValue()).endsWith(`\n${LINE}`)) throw new Error('the café line is not the last line');
      await press('Meta+ArrowDown');
      await press('Shift+Meta+ArrowLeft');
      await press('Backspace');
      await press('Backspace');
      if ((await area.inputValue()).includes(LINE)) throw new Error('the café line is still in the text');
      await pause(800);
    };
    try {
      await moment('saves the Library’s skills', async () => { saved = true; await save(); });

      await moment('asks when the café opens — the Library answers from the new line', async () => {
        await tab('conversation');
        const answer = await ask('What are the library’s weekday opening hours, and when does the café open?');
        await moveTo(answer);
        await pause(800);
      });

      await moment('reopens the skill and removes the café line with the keyboard (not saved yet)', removeLine);

      await moment('saves again — the café line is gone from the Library’s hours', async () => {
        await save();
        removed = true;
        await tab('conversation');
      });
    } finally {
      if (saved && !removed) {
        try {
          // The editor may still be open from a removal that stopped half-way: never save it with the line in.
          if (await dialog.isVisible()) {
            if ((await hoursCard().locator('textarea[name="knowledge"]').inputValue()).includes(LINE)) {
              await click(left.locator('#skills-cancel'));
              await removeLine();
            }
          } else {
            await removeLine();
          }
          await save();
          removed = true;
          await tab('conversation');
        } catch (err) {
          problems.push(`Step 5 · the café line is STILL in the Library’s “Library hours” skill — remove it in the skills editor (${String(err?.message ?? err).split('\n')[0]})`);
        }
      }
    }
  },
});

// Step 6 · Workflow forms — the Library’s booking form (with review), then the Tutor’s form with a thin description that the review flags
scenes.push({
  n: 6,
  title: 'Workflow forms',
  async run() {
    const log = left.locator('#student-log');
    let room = null;
    let tutor = null;
    // A reply that ends in a question (the Tutor's replies are not labelled 'asks', so read the text).
    const asksBack = async (item) => /\?$/.test(((await item.innerText().catch(() => '')) ?? '').replace(/\s*IDs\s*$/, '').trim()) && !/^Sent to/.test(((await item.locator('.msg-dir').first().textContent().catch(() => '')) ?? '').trim());

    await moment('asks for a group study room — the Library sends its booking form', async () => {
      await ask('Can I book a group study room for 4 people tomorrow afternoon?');
      const form = log.getByRole('listitem', { name: 'Book a group study room' }).last();
      room = (await seen(form, 5000)) ? form : null;
      if (room) await moveTo(room);
    });

    if (room) {
      await moment('fills in name and email, picks Room B and 1 hour, asks for available times', async () => {
        await typeInto(field(room, 'First name'), 'Alex');
        await typeInto(field(room, 'Last name'), 'Student');
        await typeInto(field(room, 'Email'), 'alex@example.com');
        await click(room.getByRole('button', { name: /^Room B/ }));
        await click(room.getByRole('button', { name: '1 hour' }));
        await click(room.getByRole('button', { name: 'Show available times' }));
        const slot = room.getByRole('button', { name: /^\d\d:\d\d–\d\d:\d\d$/ }).first();
        if (await seen(slot, 60000)) await moveTo(slot);
        await pause(600);
      });

      await moment('picks an afternoon slot and reviews the booking', async () => {
        const slots = room.getByRole('button', { name: /^\d\d:\d\d–\d\d:\d\d$/ });
        const afternoon = room.getByRole('button', { name: /^1[3-6]:00–/ });
        await click((await afternoon.count()) ? afternoon.first() : slots.first());
        await click(room.getByRole('button', { name: 'Review booking' }));
        await seen(room.getByRole('button', { name: 'Confirm demo booking' }), 60000);
        await pause(600);
      });

      await moment('confirms the demo booking (sends anyway if the review flags it)', async () => {
        await submit(room, 'Confirm demo booking');
        if (await seen(room.getByRole('button', { name: 'Send anyway' }), 3000)) {
          await moveTo(room.locator('.notice[data-kind="warn"]'));
          await pause(1200);
          await submit(room, 'Send anyway');
        }
      });
    }

    await moment('asks for in-person tutoring — fills the form with a thin description and submits', async () => {
      const first = await ask("I'd like in-person tutoring for calculus next Tuesday afternoon");
      let last = first;
      // The Student may ask which service is meant, and the Tutor may ask which topic: the person answers in words.
      if (await asksBack(last)) last = await ask('Tutoring, for calculus.');
      if (await asksBack(last)) last = await ask('Calculus: the chain rule.');
      await moveTo(last);
      const form = log.locator(':scope > li').filter({ has: left.getByRole('button', { name: 'Send tutoring request' }) }).last();
      if (!(await seen(form, 60000))) return;
      tutor = form;
      await typeInto(field(tutor, 'First name'), 'Alex');
      await typeInto(field(tutor, 'Last name'), 'Student');
      await typeInto(field(tutor, 'Email'), 'alex@example.com');
      await typeInto(field(tutor, 'Describe what you’d like help with.'), 'asdf');
      await submit(tutor, 'Send tutoring request');
    });

    if (tutor) {
      await moment('the review flags the thin description — cursor reads the flags, then send anyway (or shows it was accepted)', async () => {
        if (await seen(tutor.getByRole('button', { name: 'Send anyway' }), 5000)) {
          await moveTo(tutor.locator('.notice[data-kind="warn"]'));
          await pause(1200);
          await submit(tutor, 'Send anyway');
        } else {
          await moveTo(tutor);
          await pause(800);
        }
      });
    }
  },
});

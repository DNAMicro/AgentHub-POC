// Step 3 · A2UI form — the Tutor sends a form; a bad email is caught, then fixed and sent
scenes.push({
  n: 3,
  title: 'A2UI form',
  async run() {
    const log = left.locator('#student-log');
    const items = log.locator(':scope > li');
    const SUBMIT = 'Send tutoring request';

    // Index of the newest chat item that holds the tutoring form (read only; -1 if none).
    const findForm = async () => {
      for (let i = (await items.count()) - 1; i >= 0; i--) {
        if (await items.nth(i).getByRole('button', { name: SUBMIT }).count()) return i;
      }
      return -1;
    };

    let at = -1;
    await moment('asks for in-person tutoring, the form appears', async () => {
      await ask('I’d like in-person tutoring for calculus on Friday morning');
      at = await findForm();
    });
    if (at < 0) return; // the Tutor answered in words this time: the moment above shows that
    const form = items.nth(at);
    const field = (label) => form.locator(`xpath=(.//*[normalize-space(text())="${label}"])[1]/ancestor::*[.//input or .//textarea][1]`).locator('input, textarea').first();

    await moment('a bad email is caught when the form is sent', async () => {
      await typeInto(field('First name'), 'Alex');
      await typeInto(field('Last name'), 'Student');
      await typeInto(field('Email'), 'alex@example');
      await click(form.getByRole('button', { name: SUBMIT }));
      await seen(form.getByText('Please fix these before continuing').first(), 8000);
    });

    await moment('fixes the email, sends the form, it becomes a summary', async () => {
      await click(field('Email'));
      await press('Meta+A');
      await press('Backspace');
      await typeInto(field('Email'), 'alex@example.com');
      await typeInto(field('Describe what you’d like help with.'), 'Practice with the chain rule before my quiz.');
      await submit(form, SUBMIT);
    });

    if (await seen(form.getByRole('button', { name: 'Send anyway' }), 2000)) {
      await moment('the review flagged something: sends anyway', async () => {
        await submit(form, 'Send anyway');
      });
    }
  },
});

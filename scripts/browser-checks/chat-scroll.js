// Browser check: the chat (and the agent consoles) stay at the bottom — reliably — and never pull a
// reader who scrolled up. Run against the live app with playwright-cli:
//   playwright-cli -s=check open http://127.0.0.1:3000/conversation
//   playwright-cli -s=check run-code "$(cat scripts/browser-checks/chat-scroll.js)"
// Uses real questions (live models cost a few cents). "gap" = pixels between the view and the bottom.
async (page) => {
  page.setDefaultTimeout(120000);
  const results = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const gap = (sel = '#student-log') => page.$eval(sel, (l) => Math.round(l.scrollHeight - l.scrollTop - l.clientHeight));
  const following = () => page.evaluate(() => window.__chatFollow?.following);
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });
  // Send, then sample the gap while the reply arrives and renders (forms render asynchronously).
  async function sendAndWatch(text) {
    await page.locator('#message').fill(text);
    await page.locator('#message').press('Enter');
    const gaps = [];
    let busy = true;
    for (let i = 0; i < 300 && busy; i++) {
      await page.waitForTimeout(200);
      gaps.push(await gap());
      busy = await page.locator('#send').isDisabled();
    }
    for (let i = 0; i < 15; i++) { await page.waitForTimeout(200); gaps.push(await gap()); } // keep watching while it settles
    return { final: gaps.at(-1), max: Math.max(...gaps.slice(-10)) };
  }
  await page.goto('http://127.0.0.1:3000/conversation');
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.waitForTimeout(600);

  // 1. Text answers, a tall Tutor form, a generated loan surface, a generated overview.
  for (const q of ['What is the derivative of x^4? One sentence.', 'I want to arrange in-person help with calculus on Friday morning', 'Push back the due date on Marketing Research Methods by one week', 'Show my loans as a list of cards I can look over', 'What are the library hours on Sunday?']) {
    const r = await sendAndWatch(q);
    check(`at bottom after: ${q}`, r.final <= 2 && r.max <= 2, r);
  }
  // 2. The reader scrolls up while an answer is coming: they stay where they are.
  await page.locator('#message').fill('When is my statistics book due?');
  await page.locator('#message').press('Enter');
  await page.waitForTimeout(400);
  await page.locator('#student-log').hover();
  await page.mouse.wheel(0, -1500);
  await page.waitForTimeout(300);
  const topWhileReading = await page.$eval('#student-log', (l) => l.scrollTop);
  for (let i = 0; i < 300 && (await page.locator('#send').isDisabled()); i++) await page.waitForTimeout(200);
  await page.waitForTimeout(2500);
  const topAfter = await page.$eval('#student-log', (l) => l.scrollTop);
  check('a reader who scrolled up is not pulled down by the answer', Math.abs(topAfter - topWhileReading) <= 2 && (await gap()) > 50 && (await following()) === false, { topWhileReading, topAfter, gap: await gap() });
  // 3. Scrolling back to the bottom resumes following; the next answer stays in view.
  await page.mouse.wheel(0, 100000);
  await page.waitForTimeout(500);
  const r3 = await sendAndWatch('Which of my books is due first?');
  check('scrolling back down resumes following', r3.final <= 2, r3);
  // 4. Sending while scrolled up jumps to the newest message.
  await page.mouse.wheel(0, -2000);
  await page.waitForTimeout(400);
  const r4 = await sendAndWatch('What are the library hours on Saturday?');
  check('sending a message brings the chat to the bottom', r4.final <= 2, r4);
  // 5. Another tab and back; a reload (full replay, forms re-render) — still at the bottom.
  await page.goto('http://127.0.0.1:3000/activity');
  await page.waitForTimeout(1500);
  check('activity consoles at the bottom', (await gap('#library-log')) <= 2 && (await gap('#hub-log')) <= 2, { library: await gap('#library-log'), hub: await gap('#hub-log') });
  await page.goto('http://127.0.0.1:3000/conversation');
  for (let i = 0; i < 20; i++) await page.waitForTimeout(200);
  check('at bottom after a reload (replay + forms re-rendered)', (await gap()) <= 2, { gap: await gap() });
  await page.locator('#tab-activity').click();
  await page.waitForTimeout(500);
  await page.locator('#tab-conversation').click();
  await page.waitForTimeout(800);
  check('at bottom after switching tabs', (await gap()) <= 2, { gap: await gap() });
  // 6. Phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const r6 = await sendAndWatch('What are the library hours on Monday?');
  check('at bottom at phone width', r6.final <= 2, r6);
  await page.setViewportSize({ width: 1280, height: 900 });
  return JSON.stringify({ passed: results.filter((r) => r.ok).length, total: results.length, results, errors }, null, 1);
}

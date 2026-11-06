// Found 2026-11-06 (a Friday): “I'm leaving at noon on Thursday and I'll be out Friday” read as today + next Thursday
// (each weekday was resolved on its own), so the card had no dates. A later bare weekday follows the one before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionedDays, readRequest } from '../src/hr-intent.js';

const days = (t, now) => [...mentionedDays(t, new Date(`${now}T18:00:00Z`))].sort();
const cases = [
  ['2026-11-06', "I'm leaving at noon on Thursday and I'll be out Friday", ['2026-11-12', '2026-11-13']],
  ['2026-11-04', "I'm leaving at noon on Thursday and I'll be out Friday", ['2026-11-05', '2026-11-06']],
  ['2026-11-07', "I'm leaving at noon on Thursday and I'll be out Friday", ['2026-11-12', '2026-11-13']],
  ['2026-11-06', 'out Wednesday and Monday', ['2026-11-11', '2026-11-16']],
  ['2026-11-06', 'out Friday and Monday', ['2026-11-06', '2026-11-09']],
  ['2026-11-04', 'out today and Friday', ['2026-11-04', '2026-11-06']],
  ['2026-11-06', 'Monday', ['2026-11-09']],
  ['2026-11-06', 'Thursday, Friday', ['2026-11-12', '2026-11-13']],
  ['2026-11-04', 'Nov 20 and Friday', ['2026-11-06', '2026-11-20']], // only a weekday after a weekday follows it
  ['2026-11-06', 'Thursday and Nov 10', ['2026-11-10', '2026-11-12']],
];
for (const [now, text, want] of cases) test(`said on ${now}: “${text}”`, () => assert.deepEqual(days(text, now), want));

test("the noon sentence gives a card with dates on a Friday", async () => {
  const r = await readRequest({ text: "I'm not feeling well, I'm leaving at noon on Thursday and I'll be out Friday", now: new Date("2026-11-06T18:00:00Z") });
  assert.deepEqual({ beginDate: r?.prefill?.beginDate, endDate: r?.prefill?.endDate }, { beginDate: "2026-11-12", endDate: "2026-11-13" }, JSON.stringify(r));
});

for (const now of ['2026-11-06', '2026-11-04', '2026-11-08']) {
  test(`said on ${now}: the noon sentence is a part first day, then a full day`, async () => {
    const r = await readRequest({ text: "I'm not feeling well, I'm leaving at noon on Thursday and I'll be out Friday", now: new Date(`${now}T18:00:00Z`) });
    assert.equal(r?.partial?.mode, 'start_day_only', JSON.stringify(r));
    assert.equal(r.partial.hours, 5);
  });
}

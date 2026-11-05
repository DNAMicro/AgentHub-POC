// Owner, 2026-11-05: "many of the messages that are sent in the bubbles are hard to read because there is no
// proper separation and formatting". public/rich-text.js turns reply text into paragraphs and lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksOf, labelOf, sentences } from '../public/rich-text.js';
import { LAYOUT_RULE } from '../src/llm.js';
import { SYSTEM_PROMPT } from '../src/tutor-model.js';
import { SYSTEM as PROF_SYSTEM, INTERPRET_SYSTEM } from '../src/professor-model.js';
import { SYSTEM as LIB_SYSTEM } from '../src/library-model.js';

test('a short reply stays one paragraph, word for word', () => {
  assert.deepEqual(blocksOf('10 of your 25 students are seniors.', { split: true }), [{ type: 'p', text: '10 of your 25 students are seniors.' }]);
});

test('blank lines make paragraphs; "- " and "1. " lines make real lists', () => {
  const t = 'Here are the 4 Ps:\n\n- Product: what you sell\n- Price: what it costs\n\nSteps:\n1. Read the chapter\n2. Do the quiz\n\nNext up: Topic 17.';
  assert.deepEqual(blocksOf(t), [
    { type: 'p', text: 'Here are the 4 Ps:' },
    { type: 'ul', items: ['Product: what you sell', 'Price: what it costs'] },
    { type: 'p', text: 'Steps:' },
    { type: 'ol', start: 1, items: ['Read the chapter', 'Do the quiz'] },
    { type: 'p', text: 'Next up: Topic 17.' },
  ]);
});

test('a list right after a lead-in line (no blank line) is still a list', () => {
  assert.deepEqual(blocksOf('Covered so far:\n1. Overview\n2. Planning'), [{ type: 'p', text: 'Covered so far:' }, { type: 'ol', start: 1, items: ['Overview', 'Planning'] }]);
});

test('stray Markdown is unwrapped to its words', () => {
  assert.deepEqual(blocksOf('## Pricing\n**Price** is what the customer gives up.'), [{ type: 'p', text: 'Pricing\nPrice is what the customer gives up.' }]);
});

test('a long block from a model is split into short paragraphs at sentence ends', () => {
  const long = 'The 4 Ps are a common way to organize marketing decisions. Product is the bundle of core benefit, the actual product and extras like support. Price is what customers give up, which signals value as well as covering costs. Place is how the offering reaches customers when and where they want it. Promotion is the coordinated messages across advertising, social media and sales promotions. Example: a campus café sells breakfast for $3.50 by the 8:50 class.';
  const blocks = blocksOf(long, { split: true });
  assert.ok(blocks.length >= 2, `split into ${blocks.length}`);
  assert.ok(blocks.every((b) => b.type === 'p' && b.text.length <= 260));
  assert.equal(blocks.map((b) => b.text).join(' '), long, 'no word lost or changed');
});

test('a person’s own words are never split', () => {
  const long = 'Hi everyone. '.repeat(40).trim();
  assert.equal(blocksOf(long).length, 1);
});

test('abbreviations and prices do not end a sentence', () => {
  assert.deepEqual(sentences('Ask Dr. Dabirian on Tue. Nov. 10 about it. It costs $3.50 per item. Done.'), ['Ask Dr. Dabirian on Tue. Nov. 10 about it.', 'It costs $3.50 per item.', 'Done.']);
});

test('the answer prompts ask for short paragraphs and lists', () => {
  for (const p of [SYSTEM_PROMPT, PROF_SYSTEM, INTERPRET_SYSTEM, LIB_SYSTEM]) assert.ok(p.includes(LAYOUT_RULE));
});

test('a short opening label is found (drawn bold); times and sentences are not labels', () => {
  assert.equal(labelOf('Product: the offering itself'), 'Product');
  assert.equal(labelOf('Worked example: take f(x) = 2x.'), 'Worked example');
  assert.equal(labelOf('10:00 is the start'), null);
  assert.equal(labelOf('Remember that the midterm is on Friday: bring a pencil'), null);
  assert.equal(labelOf('No label here.'), null);
});

test('list labels may be up to 6 words', () => {
  assert.equal(labelOf('Use a live sales pitch comparison: show two pitches', { maxWords: 6 }), 'Use a live sales pitch comparison');
  assert.equal(labelOf('Use a live sales pitch comparison: show two pitches'), null);
});

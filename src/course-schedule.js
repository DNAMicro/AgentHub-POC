// The fictional Fall 2026 Marketing 351 schedule and our own short notes per topic.
// Dependency-free: the browser loads this file from /shared/course-schedule.js.
// Notes are original, textbook-standard concepts in our own words (never copied from a test bank).

export const TERM = { label: 'Fall 2026', start: '2026-08-25', end: '2026-12-18' };

// Review #10: the class meets Tuesdays and Thursdays, 10:00–11:15 AM, in Mihaylo Hall 2405, for the whole term. ONE source
// of truth: the student records stand-in seeds the class record from it (“TuTh 10:00AM - 11:15AM”), the class-day rule for
// cancellation offers counts only these days, and the Faculty view's header shows it (no lookup per poll).
export const MEETING = Object.freeze({
  weekdays: Object.freeze([2, 4]), // Tue, Thu (Date#getUTCDay)
  daysLabel: 'Tue & Thu',
  recordDays: 'TuTh',
  start: '10:00', end: '11:15',
  timeLabel: '10:00–11:15 AM',
  recordTime: '10:00AM - 11:15AM',
  room: 'Mihaylo Hall 2405',
});
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymdParts = (ymd) => ymd.split('-').map(Number);
const monthDay = (ymd) => { const [, m, d] = ymdParts(ymd); return `${MONTH_SHORT[m - 1]} ${d}`; };
// “08/25/2026” — the records system's own date format.
const recordDate = (ymd) => { const [y, m, d] = ymdParts(ymd); return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`; };
export const RECORD_DATES = `${recordDate(TERM.start)} - ${recordDate(TERM.end)}`;
// A day the class meets (inside the term, on a meeting weekday). Campus holidays are the caller's to remove.
export function meetsOn(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd) || ymd < TERM.start || ymd > TERM.end) return false;
  const [y, m, d] = ymdParts(ymd);
  return MEETING.weekdays.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
}
// The Faculty view's header line: “Fall 2026 · Aug 25 – Dec 18 · Tue & Thu, 10:00–11:15 AM · Mihaylo Hall 2405”.
export const meetingLine = () => `${TERM.label} · ${monthDay(TERM.start)} – ${monthDay(TERM.end)} · ${MEETING.daysLabel}, ${MEETING.timeLabel} · ${MEETING.room}`;

export const UNITS = [
  { unit: 1, from: 1, to: 7, exam: '2026-09-24' },
  { unit: 2, from: 8, to: 14, exam: '2026-10-22' },
  { unit: 3, from: 15, to: 20, exam: null },
];

const t = (term, definition) => ({ term, definition });

export const TOPICS = [
  { n: 1, name: 'An overview of marketing', unit: 1, taught: '2026-08-25', tags: ['marketing', 'basics', 'introduction', 'exchange'], notes: [
    t('Marketing', 'The activities and processes that create, communicate and deliver offerings of value to customers.'),
    t('Exchange', 'Two parties each give something of value to get something they want more.'),
    t('Marketing mix', 'The four controllable tools a firm blends: product, price, place and promotion.'),
    t('Customer relationship management', 'Building lasting, profitable relationships by focusing on each customer over time.'),
    t('Customer value', 'The gap between what a customer gets from an offering and what the customer gives up to get it.'),
  ] },
  { n: 2, name: 'Strategic planning for competitive advantage', unit: 1, taught: '2026-08-27', tags: ['strategy', 'planning', 'swot', 'competitive'], notes: [
    t('Mission statement', 'A short statement of why the organization exists and whom it serves.'),
    t('SWOT analysis', 'A review of internal strengths and weaknesses and outside opportunities and threats.'),
    t('Competitive advantage', 'Something a firm does better than rivals that customers value and rivals cannot easily copy.'),
    t('Strategic business unit', 'A division treated as its own business with its own mission, rivals and plans.'),
    t('Market penetration', 'A growth strategy that sells more of existing products in existing markets.'),
  ] },
  { n: 3, name: 'Ethics & social responsibility', unit: 1, taught: '2026-09-01', tags: ['ethics', 'responsibility', 'social', 'conduct'], notes: [
    t('Business ethics', 'The moral principles that guide how people in a company decide and act.'),
    t('Corporate social responsibility', 'A firm\'s duty to act in ways that benefit society as well as its owners.'),
    t('Stakeholder', 'Any person or group affected by what a company does, such as employees, buyers or neighbors.'),
    t('Code of ethics', 'A written guide that tells employees which behavior the company expects.'),
    t('Greenwashing', 'Making products or the firm seem more environmentally friendly than they really are.'),
  ] },
  { n: 4, name: 'The marketing environment', unit: 1, taught: '2026-09-08', tags: ['environment', 'scanning', 'trends', 'economy'], notes: [
    t('Environmental scanning', 'Collecting and studying information about outside forces that may affect the firm.'),
    t('Microenvironment', 'The nearby players a firm deals with directly, such as suppliers, customers and rivals.'),
    t('Demographics', 'Measurable traits of a population such as age, income, household size and location.'),
    t('Economic conditions', 'Inflation, unemployment and income levels that shape how much people can spend.'),
    t('Regulation', 'Laws and rules set by government that limit or guide marketing practice.'),
  ] },
  { n: 5, name: 'Developing a global vision', unit: 1, taught: '2026-09-10', tags: ['global', 'international', 'export', 'trade'], notes: [
    t('Exporting', 'Selling goods made in one country to buyers in another country.'),
    t('Licensing', 'Letting a foreign firm make and sell your product in return for fees or royalties.'),
    t('Joint venture', 'A business two or more firms own together to enter or serve a market.'),
    t('Tariff', 'A tax a government places on imported goods.'),
    t('Standardization', 'Selling the same marketing approach in every country to save cost.'),
  ] },
  { n: 6, name: 'Consumer decision making', unit: 1, taught: '2026-09-15', tags: ['consumer', 'behavior', 'buying', 'decision'], notes: [
    t('Need recognition', 'The first buying step, when a person senses a gap between what is and what is wanted.'),
    t('Evoked set', 'The small group of brands a shopper actually thinks of when considering a purchase.'),
    t('Cognitive dissonance', 'The doubt a buyer feels after buying that the choice was the right one.'),
    t('Involvement', 'How much time and effort a buyer puts into a purchase; high for costly or risky items.'),
    t('Reference group', 'People whose views and habits a consumer uses as a guide for their own choices.'),
  ] },
  { n: 7, name: 'Business marketing', unit: 1, taught: '2026-09-17', tags: ['business', 'b2b', 'organizational', 'buyers'], notes: [
    t('Business-to-business marketing', 'Selling goods and services to organizations rather than to final consumers.'),
    t('Derived demand', 'Demand for a business product that comes from demand for the consumer goods it helps make.'),
    t('Buying center', 'All the people in an organization who take part in a purchase decision.'),
    t('Straight rebuy', 'A routine reorder of something the buyer has bought before, with no changes.'),
    t('Reciprocity', 'An arrangement where two firms agree to buy from each other.'),
  ] },
  { n: 8, name: 'Segmentation & targeting', unit: 2, taught: '2026-09-29', tags: ['segmentation', 'targeting', 'positioning', 'segments'], notes: [
    t('Market segmentation', 'Dividing a large market into smaller groups of buyers with similar needs.'),
    t('Target market', 'The group of buyers a firm chooses to aim its marketing efforts at.'),
    t('Geographic segmentation', 'Grouping buyers by where they live, such as region, climate or city size.'),
    t('Psychographic segmentation', 'Grouping buyers by lifestyle, values and personality.'),
    t('Positioning', 'Shaping how buyers see a product compared with rival products.'),
    t('Undifferentiated targeting', 'Treating the whole market as one group with a single marketing mix.'),
  ] },
  { n: 9, name: 'Marketing research', unit: 2, taught: '2026-10-01', tags: ['research', 'survey', 'data', 'sampling'], notes: [
    t('Primary data', 'New information collected for the question at hand, such as a survey or interview.'),
    t('Secondary data', 'Information that was already collected for some other purpose.'),
    t('Sample', 'A smaller group chosen to stand in for the whole population being studied.'),
    t('Focus group', 'A guided discussion among a handful of people about a product or idea.'),
    t('Observation research', 'Watching how people behave instead of asking them questions.'),
  ] },
  { n: 10, name: 'Product concepts & branding', unit: 2, taught: '2026-10-06', tags: ['product', 'brand', 'branding', 'packaging'], notes: [
    t('Product line', 'A group of closely related products sold by one firm.'),
    t('Brand equity', 'The added value a well-known brand name gives a product.'),
    t('Trademark', 'A legally protected name, symbol or design that identifies a seller\'s goods.'),
    t('Convenience product', 'A low-priced item bought often with little effort, like gum.'),
    t('Private label', 'A product sold under a retailer\'s own name rather than a manufacturer\'s.'),
  ] },
  { n: 11, name: 'Developing & managing products', unit: 2, taught: '2026-10-08', tags: ['new product', 'lifecycle', 'development', 'innovation'], notes: [
    t('Product life cycle', 'The stages a product passes through: introduction, growth, maturity and decline.'),
    t('Concept testing', 'Showing an early idea to likely buyers to learn how they react before building it.'),
    t('Test marketing', 'Selling a new product in a small area first to see how the real market responds.'),
    t('Diffusion of innovation', 'The way a new idea spreads through a population over time.'),
    t('Product failure', 'A launch that does not reach its goals, often because it did not meet a real need.'),
  ] },
  { n: 12, name: 'Services & nonprofit marketing', unit: 2, taught: '2026-10-13', tags: ['services', 'nonprofit', 'intangible', 'quality'], notes: [
    t('Intangibility', 'A service cannot be seen, touched or tried before it is bought.'),
    t('Inseparability', 'A service is made and used at the same time, so the provider is part of it.'),
    t('Perishability', 'An unused service, like an empty seat, cannot be stored and sold later.'),
    t('Service quality gap', 'The difference between what customers expect from a service and what they receive.'),
    t('Nonprofit marketing', 'Marketing by organizations whose goal is a cause or service rather than profit.'),
  ] },
  { n: 13, name: 'Distribution (place)', unit: 2, taught: '2026-10-15', tags: ['distribution', 'place', 'channels', 'supply chain'], notes: [
    t('Marketing channel', 'The set of firms that help move a product from the maker to the final buyer.'),
    t('Wholesaler', 'A firm that buys in bulk from makers and resells to retailers or businesses.'),
    t('Intensive distribution', 'Selling a product in as many outlets as possible.'),
    t('Exclusive distribution', 'Giving one dealer in an area the sole right to sell the product.'),
    t('Vertical marketing system', 'A channel where the members work together as one planned unit.'),
  ] },
  { n: 14, name: 'Retailing', unit: 2, taught: '2026-10-20', tags: ['retail', 'stores', 'omnichannel', 'merchandise'], notes: [
    t('Retailing', 'All the activities involved in selling goods and services directly to final consumers.'),
    t('Department store', 'A large store that sells many product lines organized into separate departments.'),
    t('Omnichannel retailing', 'Giving shoppers one smooth experience across stores, websites and apps.'),
    t('Franchise', 'A business run by an owner who pays to use a larger company\'s name and methods.'),
    t('Store atmosphere', 'The look, sound and feel of a store meant to influence how shoppers act.'),
  ] },
  { n: 15, name: 'Marketing communications', unit: 3, taught: '2026-10-27', tags: ['communication', 'promotion', 'imc', 'message'], notes: [
    t('Promotional mix', 'The blend of advertising, public relations, sales promotion and personal selling a firm uses.'),
    t('Integrated marketing communications', 'Coordinating every message so customers see one clear, consistent story.'),
    t('Encoding', 'Turning an idea into words, pictures or symbols the receiver can understand.'),
    t('Noise', 'Anything that disturbs or distorts a message on its way to the receiver.'),
    t('AIDA model', 'Steps a message tries to move a person through: attention, interest, desire, action.'),
  ] },
  { n: 16, name: 'Advertising, PR & sales promotion', unit: 3, taught: '2026-11-03', tags: ['advertising', 'public relations', 'promotion', 'media'], notes: [
    t('Advertising', 'Paid, nonpersonal communication from a known sponsor to promote an idea or product.'),
    t('Public relations', 'Efforts to build goodwill with the public, often through news coverage that is not paid for.'),
    t('Sales promotion', 'Short-term incentives such as coupons or samples that push people to buy now.'),
    t('Media mix', 'The combination of channels, such as TV, radio, print and online, an ad campaign uses.'),
    t('Push strategy', 'Promoting to channel members so they carry and recommend the product to buyers.'),
    t('Pull strategy', 'Promoting directly to final consumers so they ask stores for the product.'),
  ] },
  { n: 17, name: 'Personal selling', unit: 3, taught: '2026-11-10', tags: ['selling', 'sales', 'prospecting', 'closing'], notes: [
    t('Personal selling', 'Two-way, face-to-face or voice communication between a seller and a buyer.'),
    t('Prospecting', 'Finding and qualifying people or firms that might become customers.'),
    t('Needs assessment', 'Asking questions to learn what the buyer really wants before presenting a solution.'),
    t('Handling objections', 'Answering a buyer\'s concerns honestly instead of ignoring them.'),
    t('Relationship selling', 'Building a long-term bond with a buyer rather than focusing on a single sale.'),
  ] },
  { n: 18, name: 'Social media', unit: 3, taught: '2026-11-17', tags: ['social', 'media', 'online', 'engagement'], notes: [
    t('Social media marketing', 'Using social networks to reach people, share content and build relationships.'),
    t('Engagement', 'How much an audience likes, shares, comments on or otherwise interacts with content.'),
    t('Influencer', 'A person with a following whose recommendations can sway what others buy.'),
    t('User-generated content', 'Posts, photos or reviews that customers create about a brand on their own.'),
    t('Viral marketing', 'A message that spreads quickly as people pass it along to their friends.'),
  ] },
  { n: 19, name: 'Pricing concepts', unit: 3, taught: '2026-11-19', tags: ['pricing', 'price', 'cost', 'demand'], notes: [
    t('Price elasticity of demand', 'How much the amount people buy changes when the price changes.'),
    t('Break-even point', 'The sales level where total revenue exactly equals total cost.'),
    t('Skimming', 'Starting with a high price for a new product and lowering it over time.'),
    t('Penetration pricing', 'Starting with a low price to win many buyers and market share quickly.'),
    t('Cost-plus markup', 'Setting a price by adding a fixed amount or percentage to the cost.'),
  ] },
  { n: 20, name: 'Marketing metrics', unit: 3, taught: '2026-12-01', tags: ['metrics', 'measurement', 'roi', 'performance'], notes: [
    t('Return on marketing investment', 'Profit gained from a marketing effort compared with what it cost.'),
    t('Market share', 'A firm\'s sales as a percentage of all sales in its market.'),
    t('Customer lifetime value', 'The total profit expected from one customer over the whole relationship.'),
    t('Conversion rate', 'The share of people who take the desired action, such as buying after a visit.'),
    t('Key performance indicator', 'A chosen number used to track whether a goal is being met.'),
  ] },
];

const pacificFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });

export function pacificDate(now) {
  return pacificFmt.format(now);
}

export function taughtTopics(now) {
  const today = pacificDate(now);
  return TOPICS.filter((x) => x.taught <= today);
}

export function isTaught(n, now) {
  return taughtTopics(now).some((x) => x.n === n);
}

const STOP = new Set(['quiz', 'quizzes', 'make', 'create', 'draft', 'write', 'give', 'build', 'topic', 'about', 'with', 'from', 'that', 'this',
  'please', 'for', 'the', 'and', 'questions', 'question', 'class', 'students', 'assistant', 'marketing', 'chapter', 'cover', 'covers', 'some']);

const words = (s) => String(s).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];

export function topicFromWords(text) {
  const s = String(text ?? '');
  const num = /\btopic\s*#?\s*(\d{1,2})\b/i.exec(s);
  if (num) { const n = Number(num[1]); return n >= 1 && n <= 20 ? n : null; }
  const given = new Set(words(s).filter((w) => !STOP.has(w) && w.length >= 4));
  if (!given.size) return null;
  const score = (list) => list.filter((w) => given.has(w)).length;
  let best = 0; let bestN = null; let tie = false;
  for (const x of TOPICS) {
    const v = score(words(x.name)) * 3 + score(x.tags.flatMap(words)) * 2 + score(x.notes.flatMap((o) => words(o.term)));
    if (v > best) { best = v; bestN = x.n; tie = false; } else if (v === best && v > 0) tie = true;
  }
  return best > 0 && !tie ? bestN : null;
}

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };

export function countFromWords(text) {
  const s = String(text ?? '').toLowerCase();
  const m = /\b(\d{1,3}|[a-z]+)\s+(?:multiple[- ]choice\s+)?questions?\b/.exec(s);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : null;
}

export function asksQuiz(text) {
  const s = String(text ?? '');
  if (/(^|\s)@(?!assistant\b)[\w-]+/i.test(s)) return false;
  return /\b(make|create|draft|write|give|build)\b[^.?!]*\bquiz(zes)?\b/i.test(s);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayLabel(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[dt.getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}

// “What topics have we covered so far?”, “which topics have I taught?”, “where are we in the course?”, “what's the next
// topic?” — answered by code from the schedule (owner, 2026-11-05: the assistant once said “no topics have been posted
// through this console”). Never a post, never a model call. Not when he tags a student, asks for a quiz or announces.
const COVERED = /\b(?:what|which)\b[^?.!]*\b(?:topics?|chapters?|units?)\b[^?.!]*\b(?:covered|cover|taught|teach|done|gone\s+over|went\s+over|finished)\b|\bwhat\s+(?:have|did)\s+(?:we|i)\s+(?:covered?|taught|teach|done|gone\s+over)\b|\bwhere\s+are\s+we\s+in\s+the\s+(?:course|class|syllabus|schedule|semester|term)\b|\b(?:what(?:['’]s|\s+is)|which\s+is)\s+(?:the\s+|our\s+)?next\s+(?:topic|chapter|unit|lecture)\b/i;
const ANNOUNCING = /^\s*(?:please\s+)?(?:notify|tell|let|inform|remind|announce|post|send)\b/i;
export function asksCovered(text) {
  const s = String(text ?? '').replace(/^\s*@assistant\b[,:]?\s*/i, '');
  if (!s.trim() || s.split(/\s+/).length > 20) return false;
  if (/(^|\s)@[\w-]+/.test(s) || asksQuiz(s) || ANNOUNCING.test(s)) return false;
  return COVERED.test(s);
}
// “What's the next topic?” gets the short answer (the next topic, then the last one); other questions get the list.
export const asksNextTopic = (text) => /\bnext\s+(?:topic|chapter|unit|lecture)\b/i.test(String(text ?? ''));
export function coveredText(now, { nextOnly = false } = {}) {
  const taught = taughtTopics(now);
  if (!taught.length) return `No Marketing 351 topics have been taught yet this term — the first class is ${dayLabel(TERM.start)}.`;
  const last = taught[taught.length - 1];
  const next = TOPICS.find((x) => x.taught > pacificDate(now));
  if (nextOnly) return next ? `Next up is Topic ${next.n}, ${next.name}, on ${dayLabel(next.taught)}. The last topic taught was Topic ${last.n}, ${last.name}, on ${dayLabel(last.taught)}.` : `Marketing 351 has covered all ${TOPICS.length} topics this term — there's no next topic.`;
  const head = taught.length === TOPICS.length
    ? `Marketing 351 has covered all ${TOPICS.length} topics this term.`
    : `Marketing 351 has covered ${taught.length === 1 ? 'Topic 1' : `Topics 1–${last.n}`} so far, most recently ${last.name} on ${dayLabel(last.taught)}.`;
  const list = taught.map((x) => `${x.n}. ${x.name}`).join('\n');
  return `${head}\n\n${list}${next ? `\n\nNext up: Topic ${next.n}, ${next.name}, on ${dayLabel(next.taught)}.` : ''}`;
}


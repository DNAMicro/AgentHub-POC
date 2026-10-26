// Part 9: the Marketing 101 course pack — a small, ORIGINAL knowledge pack for a fictional introductory
// course. Short explanations and fictional examples written for this demo; each topic cites the chapter
// of Washington State University's open textbook “Core Principles of Marketing” (CC BY-NC-SA,
// https://wsu.pressbooks.pub/marketing/) that sets its scope. Nothing here is copied from that book.
// This is not an official CSUF course or approved curriculum, and it holds no real deadlines, grades,
// policies or student progress.
const WSU = 'https://wsu.pressbooks.pub/marketing/chapter/';

export const COURSE = {
  courseId: 'mkt-101',
  title: 'Marketing 101',
  professorName: 'Marketing 101 Professor',
  note: 'A fictional introductory course for this demo — not an official CSUF course or approved curriculum.',
};

// Each topic becomes one of the professor's answer skills (its explanation is the skill's answer content).
export const TOPICS = [
  {
    id: 'value-and-needs', name: 'Marketing, customer needs and value',
    tags: ['marketing', 'customer needs', 'customer value', 'value proposition', 'exchange'],
    explanation: 'Marketing is the work of understanding what people need and creating, communicating and delivering offerings they value more than what they give up — money, time or effort. Advertising is one small visible part of it. A value proposition says which customers an offering is for, what problem it solves, and why it beats the alternatives.',
    example: 'A campus café notices students skip breakfast because lines are long before 9:00. Its real marketing question is not “what ad should we run?” but “what would make breakfast worth it for a rushed student?” — perhaps a grab-and-go option ready in under a minute.',
    sources: [`${WSU}1-1-defining-marketing/`, `${WSU}3-1-the-value-proposition/`],
  },
  {
    id: 'buying-behavior', name: 'Consumer and organizational buying behavior',
    tags: ['buying behavior', 'consumer behavior', 'decision process', 'b2b', 'buying center', 'involvement'],
    explanation: 'People move through recognizing a need, searching for information, comparing options, buying, and judging the purchase afterwards — quickly for low-involvement items, carefully for expensive or risky ones. Organizations buy differently: several people share the decision (a buying center), purchases follow formal steps, and relationships with suppliers matter.',
    example: 'A student buys a snack in seconds, but compares laptops for weeks. When the same fictional campus orders 200 laptops, IT, finance and a department head each weigh in before a purchase order is approved.',
    sources: [`${WSU}2-low-involvement-versus-high-involvement-buying-decisions-and-the-consumers-decision-making-process/`, `${WSU}5-5-buying-centers/`],
  },
  {
    id: 'research-and-testing', name: 'Marketing research and testing assumptions',
    tags: ['marketing research', 'survey', 'experiment', 'test', 'assumption', 'evidence', 'data'],
    explanation: 'Marketing research turns a decision into a question you can answer with evidence: define the problem, choose a method (interviews, surveys, observation, a small experiment), collect data from the right people, analyze it, and act. A cheap test before a big launch often beats a confident guess.',
    example: 'Before buying delivery bikes, a fictional student meal service offers delivery for two weeks to half its customers and compares orders with the other half.',
    sources: [`${WSU}4-2-marketing-research/`, `${WSU}4-3-steps-in-the-marketing-research-process/`],
  },
  {
    id: 'segmentation-targeting-positioning', name: 'Segmentation, targeting and positioning',
    tags: ['segmentation', 'segments', 'targeting', 'target market', 'positioning', 'stp', 'personas'],
    explanation: 'Segmentation splits a market into groups with similar needs (by situation, behavior, benefits sought, demographics). Targeting chooses which groups to serve. Positioning decides how you want those customers to see your offering compared with alternatives — a clear, believable place in their minds.',
    example: 'Reusable bottles: hikers want durability and capacity, commuters want something leak-proof that fits a bag, and gym-goers want easy cleaning. One company may target commuters and position its bottle as “the one that never leaks in your backpack.”',
    sources: [`${WSU}6-2-how-markets-are-segmented/`, `${WSU}6-3-selecting-target-markets-and-target-market-strategies/`, `${WSU}6-4-positioning-and-repositioning-offerings/`],
  },
  {
    id: 'products-services-branding', name: 'Products, services and branding',
    tags: ['product', 'service', 'offering', 'brand', 'branding', 'packaging', 'product life cycle'],
    explanation: 'An offering is a bundle: the core benefit, the actual product or service, and extras such as support or a guarantee. Services are intangible and vary with who delivers them, so consistency matters. A brand is the set of promises and associations customers connect with a name; packaging and labels carry part of that promise.',
    example: 'The café’s breakfast is not just a muffin: it is speed, a familiar name on the menu board, and a promise that it is ready when the 8:50 class lets out.',
    sources: [`${WSU}8-1-what-composes-an-offering/`, `${WSU}8-4-branding-labeling-and-packaging/`],
  },
  {
    id: 'pricing', name: 'Pricing fundamentals',
    tags: ['price', 'pricing', 'cost', 'discount', 'value-based pricing', 'pricing objectives'],
    explanation: 'Price is what customers give up, so it signals value as well as covering costs. Common approaches: cost-plus (cost plus a margin), competition-based (relative to alternatives), and value-based (what the benefit is worth to the customer). The right choice depends on the objective — survival, profit, growth or access.',
    example: 'If grab-and-go breakfast costs the café $2.10 to make, cost-plus might say $3.00; but if students value saving ten minutes, a value-based price of $3.50 could still feel fair.',
    sources: [`${WSU}9-1-pricing/`, `${WSU}chapter-9-3/`],
  },
  {
    id: 'distribution', name: 'Distribution and access to customers',
    tags: ['distribution', 'channel', 'place', 'delivery', 'retail', 'intermediaries', 'access'],
    explanation: 'Distribution (place) is how an offering reaches customers when and where they want it: direct sales, retailers, online, or intermediaries that add convenience. Channel choices trade off cost, control and reach.',
    example: 'The meal service can sell at a campus kiosk (cheap, limited reach), through a delivery app (reach, but fees), or with its own delivery (control, but higher cost).',
    sources: [`${WSU}10-1/`, `${WSU}722/`],
  },
  {
    id: 'promotion-digital-ethics', name: 'Promotion, digital communication, measurement and ethical marketing',
    tags: ['promotion', 'advertising', 'social media', 'digital marketing', 'imc', 'measurement', 'metrics', 'ethics', 'ethical marketing'],
    explanation: 'Promotion uses coordinated messages (advertising, social media, public relations, sales promotions) so customers hear one consistent story. Good marketers measure results — reach, conversions, cost per result — instead of assuming a campaign worked. Ethical marketing means honest claims, respect for privacy, and not exploiting vulnerable customers.',
    example: 'The café posts its breakfast on social media and puts a sign by the elevator; it counts how many orders use the code from each, and avoids claiming the muffin is “healthy” unless that is true.',
    sources: [`${WSU}11-1-integrated-marketing-communications-imc/`, `${WSU}316/`, `${WSU}7-ethics-in-b2b-markets/`],
  },
];

// Seeded lessons the professor can load into the draft (and edit) — or ignore and write a new one.
export const SEED_LESSONS = [
  {
    seedId: 'more-than-advertising', title: 'Marketing is more than advertising', topicId: 'value-and-needs',
    objective: 'Explain why marketing starts with customer needs and value, not with ads.',
    explanation: 'Marketing covers what you offer, for whom, at what price, where, and how you tell people — and it starts by understanding a real need. Advertising only tells people about decisions already made.',
    example: 'A campus café wants to launch a breakfast option. Before any poster, it watches the 8:00–9:00 rush: students skip breakfast because lines are long. So it designs a grab-and-go breakfast ready in under a minute, prices it for students, places it at a quick counter near the door — and only then announces it.',
    check: 'Name two marketing decisions the café made before it advertised anything, and the customer need behind each.',
  },
  {
    seedId: 'one-product-different-needs', title: 'One product, different needs', topicId: 'segmentation-targeting-positioning',
    objective: 'Use segmentation to see how one product serves groups with different priorities.',
    explanation: 'Customers buy the same kind of product for different reasons. Grouping them by what they value (segmentation) helps you choose whom to serve (targeting) and what to promise them (positioning).',
    example: 'Reusable bottles: hikers care about capacity and toughness, commuters about not leaking in a bag, gym-goers about easy cleaning, and gift buyers about looks. A single “great bottle for everyone” message speaks clearly to none of them.',
    check: 'Pick one of the groups above. What would you promise them, and which feature would you highlight first?',
  },
  {
    seedId: 'evidence-before-assumptions', title: 'Evidence before assumptions', topicId: 'research-and-testing',
    objective: 'Turn a business assumption into a small test before committing money.',
    explanation: 'Teams often “know” what customers want. Marketing research checks that belief with evidence: state the assumption, choose a quick way to test it, decide in advance what result would change your mind, then act on what you find.',
    example: 'A student meal service assumes customers want delivery. Instead of buying bikes, it offers delivery to half its customers for two weeks and compares order volume, order size and complaints with the other half.',
    check: 'What result from the two-week test would convince you NOT to add delivery?',
  },
];

// The professor's answer skills: one per topic, with its explanation + example as answer content.
export const PROFESSOR_DEFAULT_SKILLS = {
  skills: TOPICS.map((t) => ({
    id: t.id, kind: 'answer', enabled: true, name: t.name,
    description: `Marketing 101: ${t.name.toLowerCase()} — explanations, examples and checking your understanding.`,
    tags: t.tags.slice(0, 8), examples: [], scope: { allowed: [t.name], excluded: ['real course deadlines, grades or policies'] },
    knowledge: `${t.explanation}\nExample: ${t.example}\nSources: ${t.sources.join(' ')}`,
  })),
};

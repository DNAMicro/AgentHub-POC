// Default skills for the Library Agent, with FICTIONAL SAMPLE answer content. Not a real
// library, real policies, or real availability. Edit any of it in the ⚙ dialog; the agent
// answers only from whatever answer content is saved.
const EXCLUDED = ['tutoring or explaining subjects such as calculus', 'performing account actions (renewals, holds, payments) — guidance only'];
const skill = (id, name, description, tags, examples, allowed, knowledge) =>
  ({ id, kind: 'answer', enabled: true, name, description, tags, examples, scope: { allowed, excluded: EXCLUDED }, knowledge });

export const LIBRARY_DEFAULT_SKILLS = {
  skills: [
    skill('library-hours', 'Library hours', 'Opening hours of the (fictional) sample library, by day.',
      ['library', 'hours', 'opening times'], ['When is the library open on Sunday?'], ['opening and closing hours'],
      [
        'Sample Library (fictional) opening hours:',
        'Monday: 8:00–22:00',
        'Tuesday: 8:00–22:00',
        'Wednesday: 8:00–22:00',
        'Thursday: 8:00–22:00',
        'Friday: 8:00–18:00',
        'Saturday: 10:00–18:00',
        'Sunday: 12:00–20:00',
      ].join('\n')),
    skill('borrowing', 'Borrowing', 'How borrowing works: library card, loan periods, item limits.',
      ['library', 'borrowing', 'loans', 'checkout'], ['How long can I borrow a book?'], ['how to borrow items', 'loan periods and limits'],
      [
        'Borrow with your library card at the front desk or a self-checkout station.',
        'Standard loan period: 21 days from the day you borrow the item.',
        'Course-reserve items: 2 hours, in-library use only.',
        'You can have up to 10 items checked out at a time.',
      ].join('\n')),
    skill('renewals', 'Renewals guidance', 'How to renew borrowed items yourself. Guidance only; it cannot renew items.',
      ['library', 'renewals', 'renew'], ['How do I renew a borrowed book?'], ['how renewals work and how to do them yourself'],
      [
        'You can renew an item up to 2 times, 21 days each time, if nobody has placed a hold on it.',
        'Renew through your library account page or at the front desk.',
        'To renew one of your own items, ask about it by name (for example “renew my calculus book”): the Library Agent checks it and, if it can be renewed, sends you a renewal form.',
      ].join('\n')),
    skill('returns', 'Returns guidance', 'Where and how to return items, and overdue fees.',
      ['library', 'returns', 'overdue'], ['Where do I return a book after hours?'], ['how and where to return items', 'overdue fees'],
      [
        'Return items at the front desk during opening hours.',
        'After hours, use the 24-hour book drop by the main entrance.',
        'Overdue items are charged $0.25 per day.',
      ].join('\n')),
    skill('find-resources', 'Finding library resources', 'Searches a small sample catalog for books and resources by subject, with call numbers and locations.',
      ['library', 'catalog', 'books', 'textbooks', 'find resources'], ['Where can I find a calculus textbook?'], ['finding books and resources in the sample catalog'],
      [
        'Sample catalog (availability isn’t tracked — check the real catalog before you go):',
        'Calculus: Concepts and Exercises — call number QA303 .S25 — Floor 2, Mathematics',
        'A First Course in Linear Algebra — call number QA184 .S10 — Floor 2, Mathematics',
        'Physics for Beginners — call number QC21 .S77 — Floor 3, Sciences',
        'Writing a Research Paper — call number LB2369 .S04 — Floor 1, Study Skills',
      ].join('\n')),
    // Built-in workflow (handled by code, no answer content): the group study-room booking form.
    {
      id: 'study-room-booking', kind: 'form', enabled: true, name: 'Group study room booking',
      description: 'Books a group study room (demo): sends a booking form with demo availability, a review step, and a demo booking confirmation.',
      tags: ['study room', 'group study room', 'room booking', 'reserve a room'],
      examples: ['I want to reserve a group study room'],
      scope: { allowed: ['booking group study rooms'], excluded: ['real university reservations'] },
      knowledge: '',
    },
    // Part 8 built-in workflow: the student's own loans (synthetic demo records) and renewals. The
    // Library's model answers, asks, or composes an interface; the loan service owns every fact.
    {
      id: 'book-loans', kind: 'form', enabled: true, name: 'My loans and renewals',
      description: 'Looks up your own current loans (demo records): due dates, what you borrowed, whether and until when an item can be renewed, and renews it when you confirm.',
      tags: ['my loans', 'renew my book', 'due date', 'extend a loan', 'borrowed books'],
      examples: ['When is my calculus book due?', 'Can I keep it until after my exam?', 'Show me everything I borrowed'],
      scope: { allowed: ['the student’s own current loans and renewals'], excluded: ['real library accounts', 'fines and payments'] },
      knowledge: '',
    },
  ],
};

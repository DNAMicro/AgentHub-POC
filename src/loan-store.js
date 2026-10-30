// Part 8: a small, isolated DEMO loan service for the Library Agent. SYNTHETIC records only (sample
// titles, fictional borrowers) — not a real library system. Server side only.
//
// The backend is the authority for everything about a loan: who borrowed it, the title, the due date,
// renewal count, eligibility, the permitted return-date range and the record version. The model and the
// browser never supply any of these; they can only ask the typed operations below.
//
// Demo policy (documented in README):
//   - Up to MAX_RENEWALS renewals per loan.
//   - A renewal lets the borrower choose a new return date from the day after the current due date up
//     to RENEWAL_DAYS days after it. The backend computes and enforces that range.
//   - Not renewable: another borrower has a hold, the renewal limit is used up, the loan is overdue
//     (online renewal closes on the due date), or the item is a course-reserve copy.
//   - A renewal is complete only when renewLoan() returns ok; it bumps the record version.
//
// Persistence: loans and renewal outcomes are written to a JSON file (LOAN_STORE_FILE, default
// data/library-loans.json, git-ignored) so an outcome survives a restart and a retried operation ID can
// never renew twice. The first start seeds the fixture with due dates relative to today.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { addDays, todayIn } from './forms.js';

export const LOAN_POLICY = { maxRenewals: 2, renewalDays: 21 };
const LOAN_ID = /^L-\d{4}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Fixture: [loanId, borrowerId, title, author, call number, days until due, renewals used, hold, course reserve]
const FIXTURE = [
  ['L-1001', 'student-alex', 'Calculus: Early Transcendentals (sample edition)', 'A. Sample', 'QA303 .S25', 4, 0, false, false],
  ['L-1002', 'student-alex', 'Principles of Marketing (sample edition)', 'B. Example', 'HF5415 .E93', 11, 1, false, false],
  ['L-1003', 'student-alex', 'Organic Chemistry Lab Manual (sample)', 'C. Demo', 'QD261 .D46', 3, 0, true, false],
  ['L-1004', 'student-alex', 'Statistics in Practice (sample edition)', 'D. Fictional', 'QA276 .F53', 8, 2, false, false],
  ['L-1005', 'student-alex', 'Marketing Research Methods (sample)', 'E. Placeholder', 'HF5415.2 .P53', 6, 0, false, false],
  ['L-1006', 'student-alex', 'World History Reader (course reserve, sample)', 'F. Sample', 'D21 .S26', 1, 0, false, true],
  ['L-2001', 'student-sam', 'Linear Algebra Done Simply (sample)', 'G. Example', 'QA184 .E93', 7, 0, false, false],
];

function seed(today) {
  return FIXTURE.map(([loanId, borrowerId, title, author, callNumber, dueIn, renewals, hold, courseReserve]) => ({
    loanId, borrowerId, title, author, callNumber, checkedOut: addDays(today, dueIn - 21), dueDate: addDays(today, dueIn),
    renewals, hold, courseReserve, version: 1, synthetic: true,
  }));
}

// Eligibility from the CURRENT record and today's date. { eligible, code, reason }
function eligibilityOf(loan, today) {
  if (loan.courseReserve) return { eligible: false, code: 'course_reserve', reason: 'Course-reserve copies can’t be renewed; they go back to the reserve desk on the due date.' };
  if (loan.hold) return { eligible: false, code: 'on_hold', reason: 'Another borrower has placed a hold on this item, so it can’t be renewed.' };
  if (loan.renewals >= LOAN_POLICY.maxRenewals) return { eligible: false, code: 'renewal_limit', reason: `It has already been renewed ${loan.renewals} times, the maximum for a loan.` };
  if (loan.dueDate < today) return { eligible: false, code: 'overdue', reason: 'It is overdue; overdue items can’t be renewed online.' };
  return { eligible: true, code: 'eligible', reason: 'Eligible for renewal.' };
}

export function createLoanStore({ file = process.env.LOAN_STORE_FILE ?? 'data/library-loans.json', now = () => new Date() } = {}) {
  let state;
  if (existsSync(file)) state = JSON.parse(readFileSync(file, 'utf8'));
  else state = { seededOn: todayIn(now()), loans: seed(todayIn(now())), operations: {} };
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1));
    renameSync(tmp, file); // atomic replace: a crash never leaves a half-written file
  };
  if (!existsSync(file)) save();

  const today = () => todayIn(now());
  const own = (borrowerId, loanId) => state.loans.find((l) => l.loanId === loanId && l.borrowerId === borrowerId) ?? null;

  // The authoritative view of one loan, including what the backend computed.
  function view(loan) {
    const e = eligibilityOf(loan, today());
    return {
      loanId: loan.loanId, title: loan.title, author: loan.author, callNumber: loan.callNumber, checkedOut: loan.checkedOut,
      dueDate: loan.dueDate, renewalsUsed: loan.renewals, renewalsLeft: Math.max(0, LOAN_POLICY.maxRenewals - loan.renewals),
      eligible: e.eligible, eligibilityCode: e.code, eligibilityReason: e.reason,
      // The only dates a renewal may choose (null when not eligible).
      permittedReturnDates: e.eligible ? { earliest: addDays(loan.dueDate, 1), latest: addDays(loan.dueDate, LOAN_POLICY.renewalDays) } : null,
      version: loan.version, synthetic: true,
    };
  }

  return {
    policy: () => ({ ...LOAN_POLICY, today: today(), description: `Up to ${LOAN_POLICY.maxRenewals} renewals per loan; a renewal moves the due date to a date you choose from the day after the current due date to ${LOAN_POLICY.renewalDays} days after it. Not renewable: holds by another borrower, the renewal limit reached, overdue items, course-reserve copies.` }),
    // Typed operations. The borrower always comes from trusted context, never from the model.
    listLoans: (borrowerId) => state.loans.filter((l) => l.borrowerId === borrowerId).map(view),
    getLoan(borrowerId, loanId) {
      const loan = own(borrowerId, loanId);
      return loan ? view(loan) : null;
    },
    renewalOptions(borrowerId, loanId) {
      const loan = own(borrowerId, loanId);
      if (!loan) return { ok: false, code: 'not_found', reason: 'No such loan for this borrower.' };
      const v = view(loan);
      return { ok: true, loanId, eligible: v.eligible, code: v.eligibilityCode, reason: v.eligibilityReason, currentDueDate: v.dueDate, permittedReturnDates: v.permittedReturnDates, renewalsLeft: v.renewalsLeft, version: v.version };
    },
    // Synchronous check-and-write: no await between the checks and the update, so two submissions can't
    // both pass. Idempotent by operationId (persisted): the same request returns the stored outcome;
    // the same ID with different values is refused.
    renewLoan({ borrowerId, loanId, returnDate, expectedVersion, operationId }) {
      const request = JSON.stringify({ borrowerId, loanId, returnDate, expectedVersion });
      const previous = state.operations[operationId];
      if (previous) return previous.request === request ? { ...previous.result, duplicate: true } : { ok: false, code: 'operation_reused', reason: 'This operation ID was already used for a different request.' };
      const fail = (code, reason) => ({ ok: false, code, reason });
      let result;
      const loan = typeof loanId === 'string' && LOAN_ID.test(loanId) ? own(borrowerId, loanId) : null;
      if (!loan) result = fail('not_found', 'That loan isn’t one of yours.');
      else if (expectedVersion !== undefined && expectedVersion !== loan.version) result = fail('stale', 'This loan changed since the form was made. Look at its current details and try again.');
      else {
        const e = eligibilityOf(loan, today());
        const range = { earliest: addDays(loan.dueDate, 1), latest: addDays(loan.dueDate, LOAN_POLICY.renewalDays) };
        if (!e.eligible) result = fail(e.code, e.reason);
        else if (typeof returnDate !== 'string' || !DATE.test(returnDate)) result = fail('invalid_date', 'Choose a return date.');
        else if (returnDate < range.earliest || returnDate > range.latest) result = fail('out_of_range', `Choose a return date from ${range.earliest} to ${range.latest}.`);
        else {
          const previousDueDate = loan.dueDate;
          loan.dueDate = returnDate;
          loan.renewals += 1;
          loan.version += 1;
          result = { ok: true, receipt: { renewalId: `RN-${operationId.slice(0, 8).toUpperCase()}`, loanId: loan.loanId, title: loan.title, previousDueDate, newDueDate: loan.dueDate, renewalsUsed: loan.renewals, renewedOn: today(), synthetic: true } };
        }
      }
      state.operations[operationId] = { request, result, at: now().toISOString() };
      save();
      return result;
    },
    // Demo reset (the Student's New conversation, through the Hub): back to the starting sample, due
    // dates counted from today, renewal outcomes forgotten. Synthetic records only.
    reset() {
      state = { seededOn: today(), loans: seed(today()), operations: {} };
      save();
    },
    // Test hook only (LIBRARY_TEST_HOOKS=1): change a loan behind a form's back.
    _setHold(loanId, hold) {
      const loan = state.loans.find((l) => l.loanId === loanId);
      if (!loan) return false;
      loan.hold = hold;
      loan.version += 1;
      save();
      return true;
    },
  };
}

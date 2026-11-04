// PeopleSoft stand-in: the record store behind the PeopleSoft MCP server. SYNTHETIC records only (one
// fictional professor, sample campus holidays) — not a real HR system. Server side only.
//
// The backend is the authority for hours and balances: the model and the browser never supply them.
// The leave rules live in ./leave-rules.js (shared with the HR Agent's forecast).
//
// In memory only — nothing is written to disk. Every new store seeds the same staff; a retried
// operation ID can't file twice while the process runs, and a restart forgets requests.
// Filing records the request as sent to the manager; it deducts nothing.
import { workdays, isPair, nameOf, reasonsOf } from './absence-types.js';
import { planAbsence } from './leave-rules.js';

const seedStaff = () => [{ staffId: 'staff-amir', name: 'Professor Amir', standardHours: 8, balances: { vacation: 96, sick: 120, personalHoliday: 8 }, role: 'Department chair', appointment: '12-month', synthetic: true }];
const recordNumber = (n) => `ABS-${String(n).padStart(6, '0')}`;

export function createPeopleSoftStore({ now = () => new Date() } = {}) {
  const state = { staff: seedStaff(), requests: [], operations: new Map(), counter: 101 }; // Map: any operation id string is a plain key
  const find = (staffId) => state.staff.find((s) => s.staffId === staffId) ?? null;
  const viewOf = (s) => ({ staffId: s.staffId, name: s.name, standardHours: s.standardHours, role: s.role, appointment: s.appointment, balances: { ...s.balances } });
  const fail = (code, reason) => ({ ok: false, code, reason });

  function plan(staffId, values) {
    const person = find(staffId);
    if (!person) return fail('unknown_staff', 'Unknown staff member.');
    return planAbsence(person, values);
  }

  return {
    staff: (staffId) => { const s = find(staffId); return s ? viewOf(s) : null; },
    workdays,
    plan,
    // Synchronous check-and-write (no await between the checks and the record). Idempotent by operationId:
    // the same values return the stored receipt; the same ID with different values is refused.
    file(staffId, values, operationId, steps) {
      const request = JSON.stringify([staffId, values?.absenceType, values?.absenceReason, values?.beginDate, values?.endDate, values?.partial ?? null]);
      const previous = state.operations.get(operationId);
      if (previous) return previous.request === request ? previous.result : fail('operation_reused', 'This operation ID was already used for a different request.');
      if (!isPair(values?.absenceType, values?.absenceReason)) return fail('bad_reason', 'That reason does not belong to this absence type.');
      const p = plan(staffId, values);
      if (!p.ok) return fail(p.code, p.reason);
      const mine = new Set(workdays(values.beginDate, values.endDate));
      const clash = state.requests.find((r) => r.staffId === staffId && workdays(r.beginDate, r.endDate).some((d) => mine.has(d)));
      if (clash) return fail('overlap', `That overlaps time off already filed (${clash.beginDate} to ${clash.endDate}).`);
      const receipt = {
        requestId: `TO-${String(operationId).replace(/[^0-9a-f]/gi, '').slice(0, 8).toUpperCase()}`, recordId: recordNumber(state.counter++),
        absenceType: values.absenceType, absenceReason: values.absenceReason, absenceName: nameOf(values.absenceType),
        reasonText: reasonsOf(values.absenceType).find((r) => r.code === values.absenceReason)?.reason ?? null,
        beginDate: values.beginDate, endDate: values.endDate, hours: p.hours, status: 'sent_to_manager', steps: [...(steps ?? [])],
      };
      const result = { ok: true, receipt };
      state.requests.push({ ...receipt, staffId, operationId, at: now().toISOString() });
      state.operations.set(operationId, { request, result });
      return result;
    },
    balances: (staffId) => { const s = find(staffId); return s ? { ...s.balances } : null; },
    // Receipts for one person, newest first.
    requests: (staffId) => state.requests.filter((r) => r.staffId === staffId).map((r) => ({
      requestId: r.requestId, recordId: r.recordId, absenceType: r.absenceType, absenceReason: r.absenceReason, absenceName: r.absenceName, reasonText: r.reasonText,
      beginDate: r.beginDate, endDate: r.endDate, hours: r.hours, status: r.status,
    })).reverse(),
    // Demo reset (New conversation, through the Hub): back to the starting sample.
    reset() {
      state.staff = seedStaff();
      state.requests = [];
      state.operations = new Map();
      state.counter = 101;
    },
    _records: () => structuredClone(state.requests),
  };
}

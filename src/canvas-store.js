// Canvas LMS stand-in: the quiz store behind the Canvas MCP server. A fictional DEMO stand-in, not real Canvas.
// Server side only. In memory only — nothing is written to disk. Every start (and New conversation) begins empty,
// numbering from 4821. A retried operation ID can't create or publish twice while the process runs.
// The answer key is kept here (a quiz needs it) but never leaves in a result or in list().
import { checkQuiz } from './quiz-rules.js';
import { CLASS_MEMBERS, ADDED_YESTERDAY } from './class-seed.js';

export const CANVAS_REFUSAL_CODES = ['bad_question', 'bad_settings', 'due_in_past', 'unknown_course', 'unknown_quiz', 'operation_reused', 'reset_during_call', 'not_taught'];
export const COURSE_ID = 'mkt-351';
export const COURSE_LABEL = 'MKTG 351 (Fall 2026)';
const FIRST_QUIZ = 4821;
// Review C15: who is in the Canvas course (student id + display name; never an email or a campus ID). Seeded on every
// start and reset from the shared fictional seed, minus the student added in the records system yesterday (Canvas syncs
// overnight) — one realistic mismatch for the Faculty agent's comparison to find.
const seedMembers = () => CLASS_MEMBERS.filter(([id]) => id !== ADDED_YESTERDAY).map(([studentId, first, last]) => ({ studentId, name: `${first} ${last}` }));

export function createCanvasStore({ now = () => new Date() } = {}) {
  const state = { quizzes: [], operations: new Map(), next: FIRST_QUIZ, generation: 0, members: seedMembers() }; // Map: any operation id string is a plain key
  const fail = (code, reason) => ({ ok: false, code, reason });
  const view = (r) => ({ quizId: r.quizId, courseId: r.courseId, courseLabel: r.courseLabel, published: r.published, title: r.title, questionCount: r.questionCount, pointsTotal: r.pointsTotal, minutes: r.minutes, attempts: r.attempts, dueAt: r.dueAt });

  return {
    // The reset generation: a caller that awaits (the planner) between reading it and create() passes it back, so a
    // quiz that started before New conversation can't be written into the fresh store.
    generation: () => state.generation,
    // Synchronous check-and-write (no await between the checks and the record). Only definite successes are remembered.
    create({ courseId, quiz, operationId, generation } = {}) {
      if (generation !== undefined && generation !== state.generation) return fail('reset_during_call', 'Canvas was reset while this quiz was being saved, so nothing was saved.');
      const request = JSON.stringify(['create', courseId, quiz]);
      const previous = state.operations.get(operationId);
      if (previous) return previous.request === request ? previous.result : fail('operation_reused', 'This operation ID was already used for a different request.');
      if (courseId !== COURSE_ID) return fail('unknown_course', 'Canvas has no such course.');
      const checked = checkQuiz(quiz, now());
      if (!checked.ok) return fail(checked.code, checked.problem);
      const record = {
        quizId: state.next++, courseId, courseLabel: COURSE_LABEL, published: false, title: quiz.title.trim(),
        questionCount: quiz.questions.length, pointsTotal: quiz.questions.length * quiz.pointsEach, minutes: quiz.minutes, attempts: quiz.attempts, dueAt: quiz.dueAt,
        topic: quiz.topic, questions: structuredClone(quiz.questions), createdAt: now().toISOString(),
      };
      state.quizzes.push(record);
      const result = { ok: true, quiz: view(record) };
      state.operations.set(operationId, { request, result });
      return result;
    },
    // Idempotent: publishing a published quiz answers the same, and so does a repeated operation ID.
    publish({ courseId, quizId, operationId } = {}) {
      const request = JSON.stringify(['publish', courseId, quizId]);
      const previous = state.operations.get(operationId);
      if (previous) return previous.request === request ? previous.result : fail('operation_reused', 'This operation ID was already used for a different request.');
      if (courseId !== COURSE_ID) return fail('unknown_course', 'Canvas has no such course.');
      const record = state.quizzes.find((r) => r.quizId === quizId);
      if (!record) return fail('unknown_quiz', 'Canvas has no such quiz.');
      record.published = true;
      const result = { ok: true, quiz: view(record) };
      state.operations.set(operationId, { request, result });
      return result;
    },
    // Review C15: the course's students (read-only). A copy, sorted as seeded.
    students({ courseId } = {}) {
      if (courseId !== COURSE_ID) return fail('unknown_course', 'Canvas has no such course.');
      return { ok: true, students: state.members.map((m) => ({ ...m })) };
    },
    // Public view of every quiz (no questions, no answer key), oldest first.
    list: () => state.quizzes.map(view),
    // Demo reset (New conversation): empty, numbering back to 4821.
    reset() {
      state.quizzes = [];
      state.operations = new Map();
      state.next = FIRST_QUIZ;
      state.members = seedMembers();
      state.generation += 1;
    },
  };
}

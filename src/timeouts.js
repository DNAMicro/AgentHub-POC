// Part 15: one time budget for the staff path (no imports, so every process can read it). Each OUTER wait is
// longer than everything that runs inside it, so the innermost honest answer is the one the professor sees
// (HR's “PeopleSoft didn't answer …”, not the Hub's “didn't confirm in time”). test/timeouts.test.js checks the
// order; change these together. Each site still lets its own env variable override its value.
//
//   UI server → Hub dev proxy → Professor /author/hr-action → Hub (staff action) → HR → [tool choice, MCP call →
//   PeopleSoft (planner model)]
export const TIMEOUTS = Object.freeze({
  peoplesoftPlannerMs: 8000, // PeopleSoft's own model, inside one create_absence_request (PEOPLESOFT_MODEL_TIMEOUT_MS)
  chrsToolChoiceMs: 8000, // CHRS's AI choosing the student-records tool (CHRS_TOOL_CHOICE_TIMEOUT_MS)
  chrsRecordsCallMs: 12000, // student-records connect + one MCP call share this (STUDENT_RECORDS_TIMEOUT_MS); the call keeps at least studentRecordsPlannerMs + 2 s (src/chrs-records.js CALL_FLOOR_MS); the tool choice (8 s) is outside it: 8 + 12 = 20 s < the Hub's staff dispatch wait
  studentRecordsPlannerMs: 8000, // Student records' own model, inside one get_class_roster (STUDENT_RECORDS_MODEL_TIMEOUT_MS)
  canvasPlannerMs: 8000, // Canvas's own model, inside one create_quiz (CANVAS_MODEL_TIMEOUT_MS)
  professorCanvasToolChoiceMs: 8000, // Faculty's AI choosing the Canvas tool (PROFESSOR_CANVAS_TOOL_CHOICE_TIMEOUT_MS)
  professorCanvasCallMs: 12000, // Canvas connect + one MCP call share this (CANVAS_TIMEOUT_MS); the call keeps at least canvasPlannerMs + 2 s (src/professor-canvas.js CALL_FLOOR_MS)
  professorQuizDraftMs: 30000, // Faculty's AI drafting a quiz (PROFESSOR_QUIZ_DRAFT_TIMEOUT_MS)
  professorQuizRepairMs: 20000, // one repair of a draft that failed the checks
  professorQuizOneMoreMs: 15000, // one more question / one replaced question
  hrToolChoiceMs: 8000, // HR's AI choosing the PeopleSoft tool (HR_TOOL_CHOICE_TIMEOUT_MS)
  hrAbsenceModelMs: 30000, // HR's AI proposing the absence name on a card issue (HR_MODEL_TIMEOUT_MS)
  hrPeopleSoftCallMs: 12000, // PeopleSoft connect + one MCP call share this (PEOPLESOFT_TIMEOUT_MS). The call always keeps at least the planner + 2 s (10 s; src/hr-peoplesoft.js CALL_FLOOR_MS), so the connect gets at most 2 s; the tool choice (8 s) is outside it: 8 + 12 = 20 s < the Hub's staff wait
  hubStaffActionMs: 25000, // Hub → HR staff form action, > tool choice + MCP call (HUB_STAFF_ACTION_TIMEOUT_MS)
  hubFormActionMs: 8000, // Hub → specialist STUDENT form action, unchanged (HUB_FORM_TIMEOUT_MS)
  hubDispatchMs: 60000, // Hub → specialist chat / staff request, > absence name + tool choice + balances call (HUB_DISPATCH_TIMEOUT_MS)
  professorStaffClassifierMs: 10000, // Professor's own staff-or-class model call, before it asks the Hub (PROFESSOR_STAFF_CLASSIFIER_TIMEOUT_MS)
  professorStaffMs: 65000, // Professor → Hub staff request or action, > both Hub waits above
  hubAuthorProxyMs: 80000, // Hub dev proxy → Professor /author/*, > the classifier + the Professor's staff wait
  uiProfessorCallMs: 85000, // UI server → Hub dev proxy, > the proxy's wait
});

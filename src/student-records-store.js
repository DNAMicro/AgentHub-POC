// PeopleSoft student records stand-in: the roster store behind the student-records MCP server. SYNTHETIC records
// only (one fictional course, 25 fictional students) — not a real student information system. Dependency-free.
//
// In memory only — nothing is written to disk. The roster is a fixed constant, so every start and every reset
// gives the same 25 rows (IDs are fixed fictional 888 numbers, never random).
export const COURSE_ID = 'mkt-351';
export const INSTRUCTOR_STAFF_ID = 'staff-dabirian';
export const REFUSAL_CODES = ['not_instructor', 'unknown_course'];

const CLASS = Object.freeze({
  courseId: COURSE_ID, term: 'Fall 2026', session: 'Regular Academic Session', institution: 'California State University, Fullerton', career: 'Undergraduate',
  code: 'MKTG 351 - 01', classNumber: '12351', title: 'Principles of Marketing (Lecture)',
  daysAndTimes: 'MoTuWeThFr 10:00AM - 10:50AM', room: 'Mihaylo Hall 2405', instructor: 'Dr. Dabirian', dates: '08/24/2026 - 12/18/2026',
  enrollmentStatus: 'Enrolled', capacity: 35, enrolled: 25,
});

// [studentId, PeopleSoft ID, last, first, pronouns, plan, degree, academic level] — already sorted by last name.
const PEOPLE = [
  ['student-mariana-aguilar', '888997694', 'Aguilar', 'Mariana', '', 'Business Admin - Marketing', 'BA', 'Junior'],
  ['student-owen-bennett', '888463573', 'Bennett', 'Owen', 'he/him', 'Business Admin - Marketing', 'BA', 'Senior'],
  ['student-diego-castillo', '888579076', 'Castillo', 'Diego', '', 'Business Admin - Management', 'BA', 'Junior'],
  ['student-lily-chen', '888794048', 'Chen', 'Lily', 'she/her', 'Business Admin - Marketing', 'BA', 'Senior'],
  ['student-jordan-davis', '888749371', 'Davis', 'Jordan', 'they/them', 'Communications - Advertising', 'BA', 'Junior'],
  ['student-sara-ebrahimi', '888379656', 'Ebrahimi', 'Sara', '', 'Business Admin - Finance', 'BA', 'Senior'],
  ['student-lucas-fernandez', '888764466', 'Fernandez', 'Lucas', '', 'Business Admin - Marketing', 'BA', 'Junior'],
  ['student-isabella-garcia', '888342296', 'Garcia', 'Isabella', 'she/her', 'Business Admin - Marketing', 'BA', 'Sophomore'],
  ['student-omar-hassan', '888999621', 'Hassan', 'Omar', '', 'Business Admin - Info Systems', 'BA', 'Senior'],
  ['student-kevin-huang', '888703638', 'Huang', 'Kevin', '', 'Business Admin - Marketing', 'BA', 'Junior'],
  ['student-maya-jackson', '888519853', 'Jackson', 'Maya', '', 'Communications - Public Relations', 'BA', 'Senior'],
  ['student-daniel-kim', '888384863', 'Kim', 'Daniel', 'he/him', 'Business Admin - Ent & Hosp Mgmt', 'BA', 'Junior'],
  ['student-sofia-lopez', '888946937', 'Lopez', 'Sofia', '', 'Business Admin - Marketing', 'BA', 'Junior'],
  ['student-ethan-martinez', '888437747', 'Martinez', 'Ethan', '', 'Business Admin - Management', 'BA', 'Senior'],
  ['student-anh-nguyen', '888507695', 'Nguyen', 'Anh', '', 'Business Admin - Marketing', 'BA', 'Junior'],
  ['student-chidi-okafor', '888387696', 'Okafor', 'Chidi', 'he/him', 'Business Admin - Marketing', 'BA', 'Senior'],
  ['student-priya-patel', '888863805', 'Patel', 'Priya', '', 'Business Admin - Accounting', 'BA', 'Junior'],
  ['student-gabriel-ramirez', '888861676', 'Ramirez', 'Gabriel', '', 'Business Admin - Marketing', 'BA', 'Sophomore'],
  ['student-camila-reyes', '888952291', 'Reyes', 'Camila', 'she/her', 'Communications - Advertising', 'BA', 'Senior'],
  ['student-arjun-singh', '888874696', 'Singh', 'Arjun', '', 'Business Admin - Marketing', 'BA', 'Junior'],
  ['student-alex', '888329571', 'Student', 'Alex', '', 'Business Admin - Marketing', 'BA', 'Junior'],
  ['student-sam', '888590519', 'Student', 'Sam', '', 'Business Admin - Marketing', 'BA', 'Senior'],
  ['student-vivian-tran', '888434597', 'Tran', 'Vivian', '', 'Art - Graphic Design', 'BFA', 'Junior'],
  ['student-noah-walker', '888410022', 'Walker', 'Noah', '', 'Business Admin - Marketing', 'BA', 'Senior'],
  ['student-hana-yamamoto', '888739750', 'Yamamoto', 'Hana', '', 'Business Admin - Marketing', 'BA', 'Junior'],
];

const ROWS = PEOPLE.map(([studentId, id, last, first, pronouns, plan, degree, level]) => Object.freeze({
  studentId, id, name: `${last},${first}`, email: `${first[0].toLowerCase()}${last.toLowerCase()}@csu.fullerton.example`,
  pronouns, units: '3.00', program: 'Undergraduate Program', plan, degree, level,
}));

export function createStudentRecordsStore() {
  // Review C13 (tests only): students dropped from the class (add/drop activity). Empty in the demo; set only through the
  // records server's test hook, so a test can prove every send reads the roster fresh. Reset restores the full class.
  const dropped = new Set();
  const rows = () => ROWS.filter((r) => !dropped.has(r.studentId));
  return {
    // Refuses the wrong course first, then anyone but the course's own instructor. The answer is a copy.
    roster({ courseId, instructorStaffId } = {}) {
      if (courseId !== COURSE_ID) return { ok: false, code: 'unknown_course', reason: 'Unknown course.' };
      if (instructorStaffId !== INSTRUCTOR_STAFF_ID) return { ok: false, code: 'not_instructor', reason: 'Only the instructor of this course can see its roster.' };
      const now = rows();
      return { ok: true, roster: structuredClone({ class: { ...CLASS, enrolled: now.length }, rows: now }) };
    },
    rosterSize: () => rows().length,
    // Test hook only: drop students (by fictional student id) or add them back. Unknown ids are ignored.
    setDropped(ids = []) {
      dropped.clear();
      for (const id of ids) if (ROWS.some((r) => r.studentId === id)) dropped.add(id);
      return rows().length;
    },
    // Demo reset (New conversation): the full class again.
    reset() { dropped.clear(); },
  };
}

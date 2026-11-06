// Fictional Marketing 351 class members (review C15) — dependency-free seed data shared by separate stand-in systems, so
// Canvas's course list can be seeded without Canvas reading the student records system at runtime. Student ids and
// display names only: no email, no 888 ID, no program. test/class-seed.test.js checks it against the records roster.
export const CLASS_MEMBERS = Object.freeze([
  ['student-mariana-aguilar', 'Mariana', 'Aguilar'],
  ['student-owen-bennett', 'Owen', 'Bennett'],
  ['student-diego-castillo', 'Diego', 'Castillo'],
  ['student-lily-chen', 'Lily', 'Chen'],
  ['student-jordan-davis', 'Jordan', 'Davis'],
  ['student-sara-ebrahimi', 'Sara', 'Ebrahimi'],
  ['student-lucas-fernandez', 'Lucas', 'Fernandez'],
  ['student-isabella-garcia', 'Isabella', 'Garcia'],
  ['student-omar-hassan', 'Omar', 'Hassan'],
  ['student-kevin-huang', 'Kevin', 'Huang'],
  ['student-maya-jackson', 'Maya', 'Jackson'],
  ['student-daniel-kim', 'Daniel', 'Kim'],
  ['student-sofia-lopez', 'Sofia', 'Lopez'],
  ['student-ethan-martinez', 'Ethan', 'Martinez'],
  ['student-anh-nguyen', 'Anh', 'Nguyen'],
  ['student-chidi-okafor', 'Chidi', 'Okafor'],
  ['student-priya-patel', 'Priya', 'Patel'],
  ['student-gabriel-ramirez', 'Gabriel', 'Ramirez'],
  ['student-camila-reyes', 'Camila', 'Reyes'],
  ['student-arjun-singh', 'Arjun', 'Singh'],
  ['student-alex', 'Alex', 'Student'],
  ['student-sam', 'Sam', 'Student'],
  ['student-vivian-tran', 'Vivian', 'Tran'],
  ['student-noah-walker', 'Noah', 'Walker'],
  ['student-hana-yamamoto', 'Hana', 'Yamamoto'],
].map(Object.freeze));

// The one realistic mismatch: added to the class in the student records system yesterday; Canvas syncs overnight, so
// this student is not in the Canvas course yet.
export const ADDED_YESTERDAY = 'student-hana-yamamoto';

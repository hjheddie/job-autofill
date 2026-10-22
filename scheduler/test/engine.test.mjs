// Runs the engine against live data from the local server (npm start must be running).
import assert from 'node:assert/strict';
import { generate, prepareCourse, defaultPrefs, emptyGrid, toICS, ROWS } from '../public/engine.js';

const BASE = process.env.BASE || 'http://localhost:3000';
const term = '2027/spring';
const get = async (p) => (await fetch(BASE + p)).json();

const keys = [['CS', '124'], ['MATH', '231'], ['RHET', '105'], ['PHYS', '211']];
const courses = [];
for (const [subject, number] of keys) {
  const c = prepareCourse(await get(`/api/course?term=${term}&subject=${subject}&number=${number}`));
  assert.ok(c.sections.length, `${subject} ${number} has sections`);
  const instructors = [...new Map(c.sections.flatMap((s) => s.instructors).map((i) => [i.last + i.first, i])).values()];
  c.profs = await (await fetch(`${BASE}/api/instructors`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, subjectLabel: subject, number, instructors }),
  })).json();
  assert.ok(c.profs._course, 'course-level fallback stats present');
  courses.push(c);
}

const prefs = defaultPrefs();
const grid = emptyGrid();

let t = Date.now();
const base = generate(courses, prefs, grid, {});
console.log(`baseline: ${base.schedules.length} schedules in ${Date.now() - t}ms, truncated=${base.truncated}, best score ${base.schedules[0]?.score.toFixed(2)}`, base.problems);
assert.ok(base.schedules.length > 0);
// no time conflicts in any result
for (const s of base.schedules) {
  const slots = s.sections.flatMap((x) => x.sec.slots.map((sl) => ({ ...sl, pot: x.sec.partOfTerm })));
  for (const a of slots) for (const b of slots) {
    if (a === b || a.day !== b.day) continue;
    if (a.pot !== b.pot && a.pot !== '1' && b.pot !== '1') continue;
    assert.ok(!(a.start < b.end && b.start < a.end), 'overlap found');
  }
}
for (let i = 1; i < base.schedules.length; i++) assert.ok(base.schedules[i - 1].score >= base.schedules[i].score);

// hard break: block all mornings before noon -> nothing starts before noon
const g2 = emptyGrid();
for (const d of Object.keys(g2)) for (let i = 0; i < 10; i++) g2[d][i] = 1; // 7:00-12:00
const noon = generate(courses, prefs, g2, {});
console.log(`no mornings: ${noon.schedules.length}`, noon.problems);
for (const s of noon.schedules) for (const x of s.sections) for (const sl of x.sec.slots) assert.ok(sl.start >= 12 * 60);

// days off respected
const off = generate(courses, { ...prefs, daysOff: ['F'] }, grid, {});
for (const s of off.schedules) assert.ok(!s.metrics.dayList.includes('F'));

// impossible constraints give a readable problem
const g3 = emptyGrid();
for (const d of Object.keys(g3)) g3[d].fill(1);
const none = generate(courses, prefs, g3, {});
assert.equal(none.schedules.length, 0);
assert.ok(none.problems.length);

// ICS sanity
const ics = toICS(base.schedules[0]);
assert.match(ics, /BEGIN:VCALENDAR/);
assert.match(ics, /RRULE:FREQ=WEEKLY;UNTIL=20270505T235959/);
assert.equal(ROWS, 28);

console.log('best:', base.schedules[0].sections.map((x) => `${x.courseKey} ${x.sec.number}`).join(', '));
console.log('all engine tests passed');

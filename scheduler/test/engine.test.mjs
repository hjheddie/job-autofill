// Runs the engine against live data from the local server (npm start must be running).
import assert from 'node:assert/strict';
import { generate, alternatives, buildSchedule, components, prepareCourse, defaultPrefs, emptyGrid, toICS, ROWS } from '../public/engine.js';
import { parsePrereq, checkPrereq, normCodes } from '../public/prereq.js';

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

// pins: locking a section forces it into every result
const pinned = structuredClone(courses);
const mathC = pinned.find((c) => c.key === 'MATH 231');
const lockSec = mathC.sections.find((x) => x.comp === 'PRI' && x.slots.length);
mathC.pins = { PRI: lockSec.crn };
const pr = generate(pinned, prefs, grid, {});
assert.ok(pr.schedules.length);
for (const s of pr.schedules) assert.ok(s.sections.some((x) => x.sec.crn === lockSec.crn));

// links: restrict a lecture's discussions
const linked = structuredClone(courses);
const physC = linked.find((c) => c.key === 'PHYS 211');
const disC = components(physC).find((k) => k.key === 'DIS');
if (disC) {
  const lec = physC.sections.find((x) => x.comp === 'PRI' && x.slots.length);
  const allowedDis = disC.sections.slice(0, 2).map((x) => x.crn);
  physC.links = { [lec.crn]: { DIS: allowedDis } };
  const lr = generate(linked, prefs, grid, {});
  for (const s of lr.schedules) {
    const hasLec = s.sections.some((x) => x.sec.crn === lec.crn);
    const dis = s.sections.find((x) => x.courseKey === 'PHYS 211' && x.comp === 'DIS');
    if (hasLec && dis) assert.ok(allowedDis.includes(dis.sec.crn), 'link respected');
  }
}

// alternatives: swaps keep the schedule valid and are sorted by score delta
const alts = alternatives(courses, base.schedules[0], prefs, grid, {});
assert.ok(alts && alts.length, 'alternatives computed');
for (const a of alts) for (let i = 1; i < a.options.length; i++) assert.ok(a.options[i - 1].delta >= a.options[i].delta);
const rebuilt = buildSchedule(courses, base.schedules[0].sections.map((x) => x.sec.crn), prefs, grid, {});
assert.ok(Math.abs(rebuilt.score - base.schedules[0].score) < 1e-6, 'buildSchedule matches generate');

// duplicate collapsing: no two results share a signature
const sigs = new Set(base.schedules.map((s) => s.sections.map((x) => x.sec.crn).sort().join()));
assert.equal(sigs.size, base.schedules.length);

// prerequisites
assert.deepEqual(normCodes('cs124, Math 231 and ece220'), ['CS 124', 'MATH 231', 'ECE 220']);
const pq = parsePrereq('CS 126 or CS 128 or ECE 220; One of CS 173, MATH 213; consent of instructor');
assert.equal(pq.groups.length, 2);
assert.deepEqual(pq.other, ['consent of instructor']);
assert.equal(checkPrereq('CS 126 or CS 128; MATH 220', new Set(['CS 128'])).unmet.length, 1);
assert.ok(checkPrereq('CS 126 or CS 128', new Set(['CS 128'])).ok);

console.log('best:', base.schedules[0].sections.map((x) => `${x.courseKey} ${x.sec.number}`).join(', '));
console.log('all engine tests passed');

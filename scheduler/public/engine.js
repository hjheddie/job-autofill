// Pure scheduling logic (no DOM) so it runs in the browser, in a worker, and under node tests.

export const DAYS = ['M', 'T', 'W', 'R', 'F'];
export const DAY_NAMES = { M: 'Mon', T: 'Tue', W: 'Wed', R: 'Thu', F: 'Fri', S: 'Sat', U: 'Sun' };
export const GRID_START = 7 * 60;
export const STEP = 30;
export const ROWS = 28; // 7:00 AM .. 9:00 PM

export const emptyGrid = () => Object.fromEntries(DAYS.map((d) => [d, Array(ROWS).fill(0)]));

export const defaultPrefs = () => ({
  earliest: 0,        // minutes after midnight; 0 = no limit
  latest: 0,          // 0 = no limit
  minGap: 0,          // hard: minutes required between classes
  maxGap: 0,          // hard: longest allowed gap in a day (0 = off)
  maxConsecHours: 0,  // hard: longest run of back-to-back classes (0 = off)
  walking: 'penalize', // off | penalize | enforce
  daysOff: [],        // hard: days that must stay free
  minRmp: 0,          // hard: drop sections whose rated instructor is below this
  w: { rmp: 5, gpa: 3, soft: 5, start: 0, compact: 3, days: 2, ease: 0 },
});

const SECONDARY = new Set(['DIS', 'LAB', 'LBD', 'QZ']);

export const profKey = (i) => `${i.last}|${(i.first || '')[0] || ''}`.toLowerCase().replace(/[^a-z|]/g, '');

export function prepareCourse(course) {
  for (const s of course.sections) {
    s.slots = [];
    for (const m of s.meetings) {
      if (m.start == null || m.end == null || !m.days) continue;
      for (const day of m.days) s.slots.push({ day, start: m.start, end: m.end, bld: m.building });
    }
    s.comp = SECONDARY.has(s.type) ? s.type : 'PRI';
    s.courseKey = course.key;
  }
  course.profs ||= {};
  course.autoLinks = inferLinks(course);
  course.links ||= {}; // manual overrides: { [primary CRN]: { [component]: [allowed CRNs] } }
  course.pins ||= {};  // { [component]: CRN } sections the user locked in
  return course;
}

// Illinois section codes start with a group letter shared by a lecture and its discussions/labs
// (CS 173: lectures AL1/AL2 go with discussions ADA..ADD, lectures BL1..BL4 with BDA/BDB).
// Only inferred when every discussion/lab letter is also a lecture letter, so courses with other
// conventions (PHYS, ECE, CS 233) or a single group are left unrestricted rather than guessed.
export function inferLinks(course) {
  const letter = (s) => (s.number || '')[0] || '';
  const prim = course.sections.filter((s) => s.comp === 'PRI');
  const groups = new Set(prim.map(letter));
  const links = {};
  if (groups.size < 2) return links;
  for (const comp of components(course)) {
    if (comp.key === 'PRI') continue;
    const sGroups = new Set(comp.sections.map(letter));
    if (![...sGroups].every((g) => groups.has(g))) continue;
    for (const p of prim) {
      const match = comp.sections.filter((s) => letter(s) === letter(p));
      if (match.length) (links[p.crn] ||= {})[comp.key] = match.map((s) => s.crn); // lectures with none stay unrestricted
    }
  }
  return links;
}

// The discussions/labs allowed with a lecture: the user's manual choice wins over the inferred one.
export function effectiveLinks(course, primaryCrn, comp) {
  return course.links?.[primaryCrn]?.[comp] ?? (course.autoLinkOff ? undefined : course.autoLinks?.[primaryCrn]?.[comp]);
}

// A course is a set of components (lecture, discussion, lab...); you need one section of each.
export function components(course) {
  const map = new Map();
  for (const s of course.sections) {
    if (!map.has(s.comp)) {
      map.set(s.comp, { key: s.comp, label: s.comp === 'PRI' ? 'Lecture / main' : s.typeName, sections: [] });
    }
    map.get(s.comp).sections.push(s);
  }
  return [...map.values()].sort((a, b) => (a.key === 'PRI' ? -1 : b.key === 'PRI' ? 1 : 0));
}

const potOverlap = (a, b) => a === b || a === '1' || b === '1';

// Estimated walking distance between two buildings (straight line x 1.3), or null if a location is unknown.
export function distanceMeters(b1, b2, geo) {
  const p = geo?.[b1];
  const q = geo?.[b2];
  if (!p || !q) return null;
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(q.lat - p.lat);
  const dLon = rad(q.lon - p.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(p.lat)) * Math.cos(rad(q.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) * 1.3; // streets are not straight lines
}

export function walkMinutes(b1, b2, geo, fallback = 7) {
  if (!b1 || !b2 || b1 === b2) return b1 && b1 === b2 ? 2 : 0;
  const meters = distanceMeters(b1, b2, geo);
  return meters == null ? fallback : Math.ceil(meters / 80) + 1; // ~4.8 km/h
}

// Every pair of back-to-back classes on the same day, with how far apart they are and how much slack the gap leaves.
export function transitions(schedule, geo) {
  const byDay = {};
  for (const x of schedule.sections) {
    for (const m of x.sec.meetings) {
      if (m.start == null) continue;
      for (const day of m.days) {
        (byDay[day] ||= []).push({ day, start: m.start, end: m.end, bld: m.building, room: m.room, course: x.courseKey, type: x.sec.type });
      }
    }
  }
  const out = [];
  for (const day of Object.keys(byDay).sort((a, b) => 'MTWRFSU'.indexOf(a) - 'MTWRFSU'.indexOf(b))) {
    const arr = byDay[day].sort((a, b) => a.start - b.start);
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1];
      const b = arr[i];
      const gap = b.start - a.end;
      const walk = walkMinutes(a.bld, b.bld, geo);
      const meters = a.bld && a.bld === b.bld ? 0 : distanceMeters(a.bld, b.bld, geo);
      out.push({ day, from: a, to: b, gap, walk, meters, known: meters != null || !a.bld || !b.bld, slack: gap - walk });
    }
  }
  return out;
}

const overlaps = (s1, e1, s2, e2) => s1 < e2 && s2 < e1;

function sectionAllowed(sec, course, prefs, grid) {
  if (course.excluded?.[sec.crn]) return false;
  if (course.pins?.[sec.comp] && course.pins[sec.comp] !== sec.crn) return false;
  for (const sl of sec.slots) {
    if (prefs.daysOff.includes(sl.day)) return false;
    if (prefs.earliest && sl.start < prefs.earliest) return false;
    if (prefs.latest && sl.end > prefs.latest) return false;
    const col = grid[sl.day];
    if (col) {
      for (let i = 0; i < ROWS; i++) {
        if (col[i] !== 1) continue;
        const cs = GRID_START + i * STEP;
        if (overlaps(sl.start, sl.end, cs, cs + STEP)) return false;
      }
    }
  }
  if (prefs.minRmp) {
    for (const i of sec.instructors) {
      const r = course.profs[profKey(i)]?.rmp?.rating;
      if (r != null && r < prefs.minRmp) return false;
    }
  }
  return true;
}

function pairConflict(a, b, prefs, geo) {
  if (!potOverlap(a.partOfTerm, b.partOfTerm)) return false;
  for (const x of a.slots) {
    for (const y of b.slots) {
      if (x.day !== y.day) continue;
      if (overlaps(x.start, x.end, y.start, y.end)) return true;
      const gap = x.end <= y.start ? y.start - x.end : x.start - y.end;
      if (gap < prefs.minGap) return true;
      if (prefs.walking === 'enforce' && gap < walkMinutes(x.bld, y.bld, geo)) return true;
    }
  }
  return false;
}

// A lecture can be limited to specific discussions/labs via course.links.
function linkOk(a, b, byKey) {
  if (a.courseKey !== b.courseKey) return true;
  const course = byKey.get(a.courseKey);
  if (!course) return true;
  const [p, s] = a.comp === 'PRI' && b.comp !== 'PRI' ? [a, b] : b.comp === 'PRI' && a.comp !== 'PRI' ? [b, a] : [];
  if (!p) return true;
  const allowed = effectiveLinks(course, p.crn, s.comp);
  return !allowed || allowed.includes(s.crn);
}

// Instructors not yet assigned (common for future terms) fall back to course-level stats.
const profsOf = (course, sec) => (sec.instructors.length
  ? sec.instructors.map((i) => course.profs[profKey(i)])
  : [course.profs._course]);

function averageOver(chosen, pick, neutral) {
  const perCourse = new Map();
  let known = 0;
  let total = 0;
  for (const c of chosen) {
    const e = perCourse.get(c.course.key) || { course: c.course, sum: 0, w: 0 };
    for (const p of profsOf(c.course, c.sec)) {
      const v = pick(p);
      const w = c.comp === 'PRI' ? 1 : 0.5;
      total++;
      if (v != null) known++;
      e.sum += (v ?? neutral) * w;
      e.w += w;
    }
    perCourse.set(c.course.key, e);
  }
  let num = 0;
  let den = 0;
  for (const e of perCourse.values()) {
    if (!e.w) continue;
    const cr = e.course.credits || 1;
    num += (e.sum / e.w) * cr;
    den += cr;
  }
  return { avg: den ? num / den : neutral, known, total };
}

function evaluate(chosen, prefs, grid, geo) {
  const byDay = {};
  for (const c of chosen) for (const sl of c.sec.slots) (byDay[sl.day] ||= []).push(sl);
  let gapMin = 0;
  let maxGap = 0;
  let maxConsec = 0;
  let firstSum = 0;
  let walkTight = 0;
  let earliest = Infinity;
  let latest = 0;
  const dayList = Object.keys(byDay);
  for (const d of dayList) {
    const arr = byDay[d].sort((a, b) => a.start - b.start);
    firstSum += arr[0].start;
    earliest = Math.min(earliest, arr[0].start);
    let chain = arr[0].end - arr[0].start;
    maxConsec = Math.max(maxConsec, chain);
    for (let j = 1; j < arr.length; j++) {
      const gap = Math.max(0, arr[j].start - arr[j - 1].end);
      gapMin += gap;
      maxGap = Math.max(maxGap, gap);
      if (gap < walkMinutes(arr[j - 1].bld, arr[j].bld, geo)) walkTight++;
      chain = gap <= 15 ? chain + gap + (arr[j].end - arr[j].start) : arr[j].end - arr[j].start;
      maxConsec = Math.max(maxConsec, chain);
    }
    latest = Math.max(latest, ...arr.map((x) => x.end));
  }
  if (prefs.maxGap && maxGap > prefs.maxGap) return null;
  if (prefs.maxConsecHours && maxConsec > prefs.maxConsecHours * 60) return null;

  let softMin = 0;
  for (const d of dayList) {
    const col = grid[d];
    if (!col) continue;
    for (const sl of byDay[d]) {
      for (let i = 0; i < ROWS; i++) {
        if (col[i] !== 2) continue;
        const cs = GRID_START + i * STEP;
        softMin += Math.max(0, Math.min(sl.end, cs + STEP) - Math.max(sl.start, cs));
      }
    }
  }

  const rmp = averageOver(chosen, (p) => p?.rmp?.rating, 3.5);
  const gpa = averageOver(chosen, (p) => p?.gpa?.gpa, 3.4);
  const diff = averageOver(chosen, (p) => p?.rmp?.difficulty, 3);
  const aRate = averageOver(chosen, (p) => p?.gpa?.aRate, 0.45);
  const wRate = averageOver(chosen, (p) => p?.gpa?.wRate, 0.05);
  const firstAvg = dayList.length ? firstSum / dayList.length : 600;
  const credits = [...new Map(chosen.map((c) => [c.course.key, c.course.credits || 0])).values()]
    .reduce((a, b) => a + b, 0);

  const w = prefs.w;
  const parts = {
    rmp: (w.rmp * (rmp.avg - 3.5)) / 1.2,
    gpa: (w.gpa * (gpa.avg - 3.4)) / 0.4,
    soft: (-w.soft * softMin) / 180,
    start: w.start * Math.max(-2, Math.min(2, (firstAvg - 600) / 120)),
    compact: (-w.compact * gapMin) / 240,
    days: (-w.days * (dayList.length - 3)) / 2,
    ease: ((w.ease || 0) * ((3 - diff.avg) + (aRate.avg - 0.45) / 0.2)) / 2,
    walk: prefs.walking === 'penalize' ? -2 * walkTight : 0,
  };
  const score = Object.values(parts).reduce((a, b) => a + b, 0);

  return {
    score,
    parts,
    sections: chosen.map((c) => ({
      courseKey: c.course.key,
      title: c.course.title,
      comp: c.comp,
      sec: c.sec,
    })),
    metrics: {
      days: dayList.length, dayList, gapMin, maxGap, maxConsec, softMin, firstAvg, walkTight, credits,
      earliest: earliest === Infinity ? 0 : earliest, latest,
      rmp: rmp.avg, rmpKnown: rmp.known, rmpTotal: rmp.total,
      gpa: gpa.avg, gpaKnown: gpa.known, gpaTotal: gpa.total,
      diff: diff.avg, aRate: aRate.avg, wRate: wRate.avg,
    },
  };
}

function standaloneScore(sec, course, prefs, grid) {
  const w = prefs.w;
  const ps = profsOf(course, sec);
  const avg = (pick, neutral) => ps.reduce((a, p) => a + (pick(p) ?? neutral), 0) / ps.length;
  let softMin = 0;
  for (const sl of sec.slots) {
    const col = grid[sl.day];
    if (!col) continue;
    for (let i = 0; i < ROWS; i++) {
      if (col[i] !== 2) continue;
      const cs = GRID_START + i * STEP;
      softMin += Math.max(0, Math.min(sl.end, cs + STEP) - Math.max(sl.start, cs));
    }
  }
  const first = sec.slots.length ? Math.min(...sec.slots.map((s) => s.start)) : 600;
  return (w.rmp * (avg((p) => p?.rmp?.rating, 3.5) - 3.5)) / 1.2
    + (w.gpa * (avg((p) => p?.gpa?.gpa, 3.4) - 3.4)) / 0.4
    - (w.soft * softMin) / 180
    + w.start * Math.max(-2, Math.min(2, (first - 600) / 120))
    - (w.days * new Set(sec.slots.map((s) => s.day)).size) / 2
    + ((w.ease || 0) * ((3 - avg((p) => p?.rmp?.difficulty, 3)) + (avg((p) => p?.gpa?.aRate, 0.45) - 0.45) / 0.2)) / 2;
}

// ---------- search ----------

function buildContext(courses, prefs, grid, geo) {
  const byKey = new Map(courses.map((c) => [c.key, c]));
  const comps = [];
  const problems = [];
  for (const course of courses) {
    for (const comp of components(course)) {
      if (course.skip?.[comp.key]) continue;
      const secs = comp.sections.filter((s) => sectionAllowed(s, course, prefs, grid));
      if (!secs.length) problems.push(`${course.key} ${comp.label}: no section fits your constraints`);
      comps.push({ course, comp: comp.key, label: comp.label, secs });
    }
  }
  comps.sort((a, b) => a.secs.length - b.secs.length);
  // Try each component's most promising sections first so a capped search still finds good schedules.
  for (const c of comps) {
    const q = new Map(c.secs.map((s) => [s, standaloneScore(s, c.course, prefs, grid)]));
    c.secs.sort((a, b) => q.get(b) - q.get(a));
  }
  const memo = new Map();
  const conflict = (a, b) => {
    const k = a.crn < b.crn ? `${a.crn}|${b.crn}` : `${b.crn}|${a.crn}`;
    let v = memo.get(k);
    if (v === undefined) memo.set(k, (v = pairConflict(a, b, prefs, geo) || !linkOk(a, b, byKey)));
    return v;
  };
  const evalSel = (sel) => evaluate(sel.map((sec, i) => ({ course: comps[i].course, comp: comps[i].comp, sec })), prefs, grid, geo);
  return { comps, problems, conflict, evalSel, byKey };
}

// Replace section i by alt; if that now conflicts with others (e.g. a linked discussion), re-pick those.
function trySwap(ctx, sel, i, alt) {
  const trial = sel.slice();
  trial[i] = alt;
  for (let j = 0; j < trial.length; j++) {
    if (j === i || !ctx.conflict(trial[i], trial[j])) continue;
    let bestAlt = null;
    let bestScore = -Infinity;
    for (const cand of ctx.comps[j].secs) {
      if (cand === trial[j]) continue;
      if (trial.some((o, k) => k !== j && ctx.conflict(o, cand))) continue;
      const t2 = trial.slice();
      t2[j] = cand;
      const r = ctx.evalSel(t2);
      if (r && r.score > bestScore) { bestScore = r.score; bestAlt = cand; }
    }
    if (!bestAlt) return null;
    trial[j] = bestAlt;
  }
  for (let a = 0; a < trial.length; a++) {
    for (let b = a + 1; b < trial.length; b++) if (ctx.conflict(trial[a], trial[b])) return null;
  }
  return trial;
}

function improve(ctx, sel, passes = 6) {
  let best = ctx.evalSel(sel);
  if (!best) return null;
  for (let p = 0; p < passes; p++) {
    let improved = false;
    for (let i = 0; i < sel.length; i++) {
      for (const alt of ctx.comps[i].secs) {
        if (alt === sel[i]) continue;
        const trial = trySwap(ctx, sel, i, alt);
        if (!trial) continue;
        const r = ctx.evalSel(trial);
        if (r && r.score > best.score + 1e-9) { sel = trial; best = r; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best;
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const selOf = (ctx, r) => ctx.comps.map((c) => r.sections.find((x) => x.courseKey === c.course.key && x.comp === c.comp)?.sec);

// Schedules that only differ by interchangeable sections (same times, places and instructors) are duplicates.
function signature(r) {
  return r.sections
    .map((x) => `${x.courseKey}|${x.comp}|${x.sec.slots.map((s) => `${s.day}${s.start}-${s.end}${s.bld}`).sort().join(',')}|${x.sec.instructors.map(profKey).join(',')}`)
    .sort().join(';');
}

// Returns { schedules, problems, truncated }. Schedules are sorted best-first.
export function generate(courses, prefs, grid, geo, opts = {}) {
  const maxNodes = opts.maxNodes ?? 600000;
  const keep = opts.keep ?? 100;
  const timeMs = opts.timeMs ?? 2000;
  if (!courses.length) return { schedules: [], problems: ['Add at least one course.'], truncated: false };
  const ctx = buildContext(courses, prefs, grid, geo);
  if (ctx.problems.length) return { schedules: [], problems: ctx.problems, truncated: false };
  const { comps, conflict } = ctx;

  const chosen = [];
  let pool = [];
  let nodes = 0;
  let truncated = false;
  let conflictFree = 0;
  const trim = () => {
    pool.sort((a, b) => b.score - a.score);
    pool = pool.slice(0, keep * 20);
  };

  const rec = (i) => {
    if (truncated) return;
    if (i === comps.length) {
      conflictFree++;
      const r = evaluate(chosen, prefs, grid, geo);
      if (r) {
        pool.push(r);
        if (pool.length > keep * 40) trim();
      }
      return;
    }
    for (const sec of comps[i].secs) {
      if (++nodes > maxNodes) { truncated = true; return; }
      if (chosen.some((p) => conflict(p.sec, sec))) continue;
      chosen.push({ course: comps[i].course, comp: comps[i].comp, sec });
      rec(i + 1);
      chosen.pop();
    }
  };
  rec(0);
  trim();

  // Hill-climb from the best DFS results and from random starts. This is what keeps a
  // capped search from missing good schedules, and it needs no exhaustive pass.
  const t0 = Date.now();
  const rand = mulberry32(12345);
  const polished = [];
  if (comps.length > 1 || truncated) {
    for (const r of pool.slice(0, 30)) {
      const b = improve(ctx, selOf(ctx, r));
      if (b) polished.push(b);
    }
    if (truncated) {
      while (Date.now() - t0 < timeMs) {
        const sel = [];
        let ok = true;
        for (let i = 0; i < comps.length && ok; i++) {
          const opts2 = comps[i].secs.filter((s) => !sel.some((o) => conflict(o, s)));
          if (!opts2.length) ok = false;
          else sel.push(opts2[Math.floor(rand() * opts2.length)]);
        }
        if (!ok) continue;
        const b = improve(ctx, sel);
        if (b) polished.push(b);
      }
    }
  }

  const bySig = new Map();
  for (const r of [...pool, ...polished]) {
    const sig = signature(r);
    const prev = bySig.get(sig);
    if (!prev) { r.variants = 1; bySig.set(sig, r); }
    else {
      prev.variants += 1;
      if (r.score > prev.score) { r.variants = prev.variants; bySig.set(sig, r); }
    }
  }
  const schedules = [...bySig.values()].sort((a, b) => b.score - a.score).slice(0, keep);

  const problems = [];
  if (!schedules.length) {
    problems.push(conflictFree
      ? 'Every conflict-free combination breaks your gap or consecutive-class limits.'
      : 'These courses cannot be combined without time conflicts under your settings.');
  }
  return { schedules, problems, truncated };
}

// For each section of a schedule, the best replacements (one section swap, with any forced fix-ups).
// Used for "what if" swaps and as backups when a section fills.
export function alternatives(courses, schedule, prefs, grid, geo, perSection = 5) {
  const ctx = buildContext(courses, prefs, grid, geo);
  const sel = ctx.comps.map((c) => {
    const x = schedule.sections.find((y) => y.courseKey === c.course.key && y.comp === c.comp);
    return x && c.secs.find((s) => s.crn === x.sec.crn);
  });
  if (sel.some((s) => !s)) return null;
  const base = ctx.evalSel(sel);
  if (!base) return null;
  return ctx.comps.map((c, i) => {
    const options = [];
    for (const alt of c.secs) {
      if (alt === sel[i]) continue;
      const trial = trySwap(ctx, sel, i, alt);
      const r = trial && ctx.evalSel(trial);
      if (r) {
        r.variants = 1;
        options.push({
          crn: alt.crn,
          delta: r.score - base.score,
          changed: trial.map((s, k) => (s !== sel[k] && k !== i ? s.crn : null)).filter(Boolean),
          result: r,
        });
      }
    }
    options.sort((a, b) => b.delta - a.delta);
    return { courseKey: c.course.key, comp: c.comp, label: c.label, current: sel[i].crn, options: options.slice(0, perSection) };
  });
}

// Rebuilds a schedule from CRNs (shared links, saved plans) ignoring hard limits.
export function buildSchedule(courses, crns, prefs, grid, geo) {
  const chosen = [];
  for (const crn of crns) {
    for (const course of courses) {
      const sec = course.sections?.find((s) => s.crn === crn);
      if (sec) chosen.push({ course, comp: sec.comp, sec });
    }
  }
  if (chosen.length !== crns.length) return null;
  return evaluate(chosen, { ...prefs, maxGap: 0, maxConsecHours: 0 }, grid, geo);
}

// ---------- formatting & export ----------

export function fmtTime(min) {
  const h = Math.floor(min / 60);
  const m = String(min % 60).padStart(2, '0');
  return `${((h + 11) % 12) + 1}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function fmtDuration(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

const ICS_DAY = { U: 'SU', M: 'MO', T: 'TU', W: 'WE', R: 'TH', F: 'FR', S: 'SA' };
const WEEKDAY = { U: 0, M: 1, T: 2, W: 3, R: 4, F: 5, S: 6 };
const icsEscape = (s) => String(s).replace(/([\\;,])/g, '\\$1').replace(/\n/g, '\\n');
const pad = (n) => String(n).padStart(2, '0');

export function toICS(schedule) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//illini-scheduler//EN', 'CALSCALE:GREGORIAN'];
  let n = 0;
  for (const { courseKey, title, sec } of schedule.sections) {
    for (const m of sec.meetings) {
      if (m.start == null || !m.days || !sec.startDate || !sec.endDate) continue;
      const [y, mo, d] = sec.startDate.split('-').map(Number);
      const wanted = new Set([...m.days].map((x) => WEEKDAY[x]));
      const first = new Date(Date.UTC(y, mo - 1, d));
      while (!wanted.has(first.getUTCDay())) first.setUTCDate(first.getUTCDate() + 1);
      const ymd = `${first.getUTCFullYear()}${pad(first.getUTCMonth() + 1)}${pad(first.getUTCDate())}`;
      const stamp = (min) => `${ymd}T${pad(Math.floor(min / 60))}${pad(min % 60)}00`;
      const until = sec.endDate.replace(/-/g, '');
      lines.push(
        'BEGIN:VEVENT',
        `UID:${sec.crn}-${n++}@illini-scheduler`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}`,
        `DTSTART:${stamp(m.start)}`,
        `DTEND:${stamp(m.end)}`,
        `RRULE:FREQ=WEEKLY;UNTIL=${until}T235959;BYDAY=${[...m.days].map((x) => ICS_DAY[x]).join(',')}`,
        `SUMMARY:${icsEscape(`${courseKey} ${m.typeName || ''}`.trim())}`,
        `LOCATION:${icsEscape(`${m.room} ${m.building}`.trim())}`,
        `DESCRIPTION:${icsEscape(`${title}\nCRN ${sec.crn}, section ${sec.number}\n${m.instructors.map((i) => `${i.first} ${i.last}`).join(', ')}`)}`,
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// Data layer for the scheduler: proxies/caches Course Explorer, Rate My Professors,
// the UIUC GPA dataset and building geocoding. Shared by dev-server.js and api/index.js.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data'); // precomputed datasets committed to the repo
// Vercel's filesystem is read-only except /tmp.
const CACHE = process.env.VERCEL ? '/tmp/illini-cache' : path.join(__dirname, '.cache');
const CIS = 'https://courses.illinois.edu/cisapp/explorer/schedule';
const GPA_URL = 'https://raw.githubusercontent.com/wadefagen/datasets/main/gpa/uiuc-gpa-dataset.csv';
const RMP_SCHOOL = 'U2Nob29sLTExMTI='; // base64 "School-1112" (UIUC)
const UA = 'illini-scheduler/0.1 (personal use)';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// ---------- small utilities ----------

const inflight = new Map();

// JSON cache on disk with a TTL; concurrent callers share one producer run.
async function cached(key, ttl, produce) {
  const file = path.join(CACHE, key.replace(/[^\w.-]+/g, '_') + '.json');
  try {
    const st = await fsp.stat(file);
    if (Date.now() - st.mtimeMs < ttl) return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {}
  if (inflight.has(file)) return inflight.get(file);
  const p = (async () => {
    const val = await produce();
    await fsp.mkdir(CACHE, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(val));
    return val;
  })().finally(() => inflight.delete(file));
  inflight.set(file, p);
  return p;
}

async function getText(url, init) {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init?.headers || {}) } });
  if (!res.ok) {
    throw Object.assign(new Error(`${res.status} from ${new URL(url).host}`), { status: res.status === 404 ? 404 : 502 });
  }
  return res.text();
}

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]).trim() : '';
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// ---------- Course Explorer ----------

const TERM_RE = /^\d{4}\/(spring|summer|fall|winter)$/;

function parseTime(s) {
  const m = /(\d+):(\d+)\s*(AM|PM)/i.exec(s || '');
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}

// "01-19-27Z" -> "2027-01-19"
function parseDate(s) {
  const m = /(\d\d)-(\d\d)-(\d\d)/.exec(s || '');
  return m ? `20${m[3]}-${m[1]}-${m[2]}` : null;
}

const firstNumber = (s) => {
  const m = /[\d.]+/.exec(s || '');
  return m ? parseFloat(m[0]) : 0;
};

function parseCourse(xml, subject, number) {
  const sectionsStart = xml.indexOf('<detailedSections>');
  const head = sectionsStart < 0 ? xml : xml.slice(0, sectionsStart);
  const course = {
    key: `${subject} ${number}`,
    subject,
    number,
    title: tag(head, 'label'),
    description: tag(head, 'description'),
    credits: firstNumber(tag(head, 'creditHours')),
    sections: [],
  };
  for (const m of xml.matchAll(/<detailedSection id="(\d+)"[^>]*>([\s\S]*?)<\/detailedSection>/g)) {
    const body = m[2].replace(/<parents>[\s\S]*?<\/parents>/, '');
    const meetings = [];
    for (const mm of body.matchAll(/<meeting id="\d+">([\s\S]*?)<\/meeting>/g)) {
      const t = /<type code="([^"]*)">([^<]*)<\/type>/.exec(mm[1]);
      const days = tag(mm[1], 'daysOfTheWeek');
      const instructors = [...mm[1].matchAll(/<instructor lastName="([^"]*)" firstName="([^"]*)"/g)]
        .map((i) => ({ last: decode(i[1]), first: decode(i[2]) }));
      meetings.push({
        start: parseTime(tag(mm[1], 'start')),
        end: parseTime(tag(mm[1], 'end')),
        days: /^[MTWRFSU]+$/.test(days) ? days : '',
        building: tag(mm[1], 'buildingName').replace(/^n\.a\.$/, ''),
        room: tag(mm[1], 'roomNumber'),
        type: t ? t[1] : '',
        typeName: t ? decode(t[2]) : '',
        instructors,
      });
    }
    const instructors = [];
    for (const mt of meetings) for (const i of mt.instructors) {
      if (!instructors.some((x) => x.last === i.last && x.first === i.first)) instructors.push(i);
    }
    const bodyNoMeetings = body.replace(/<meetings>[\s\S]*<\/meetings>/, '');
    course.sections.push({
      crn: m[1],
      number: tag(body, 'sectionNumber'),
      type: meetings[0]?.type || '',
      typeName: meetings[0]?.typeName || '',
      partOfTerm: tag(body, 'partOfTerm') || '1',
      startDate: parseDate(tag(body, 'startDate')),
      endDate: parseDate(tag(body, 'endDate')),
      credits: firstNumber(tag(bodyNoMeetings, 'creditHours')) || null,
      notes: [tag(body, 'sectionText'), tag(body, 'sectionNotes'), tag(body, 'sectionCappArea')]
        .filter(Boolean).join(' '),
      meetings,
      instructors,
    });
  }
  return course;
}

const getSubjects = (term) => cached(`subjects_${term}`, DAY, async () => {
  const xml = await getText(`${CIS}/${term}.xml`);
  const sec = xml.slice(xml.indexOf('<subjects>'));
  return [...sec.matchAll(/<subject id="([^"]+)"[^>]*>([^<]*)<\/subject>/g)]
    .map((m) => ({ id: m[1], label: decode(m[2]) }));
});

const getCourseList = (term, subject) => cached(`courses_${term}_${subject}`, 6 * HOUR, async () => {
  const xml = await getText(`${CIS}/${term}/${subject}.xml`);
  const sec = xml.slice(xml.indexOf('<courses>'));
  return [...sec.matchAll(/<course id="([^"]+)"[^>]*>([^<]*)<\/course>/g)]
    .map((m) => ({ number: m[1], title: decode(m[2]) }));
});

const getCourse = (term, subject, number) => cached(`course_${term}_${subject}_${number}`, 3 * HOUR, async () => {
  const xml = await getText(`${CIS}/${term}/${subject}/${number}.xml?mode=detail`);
  return parseCourse(xml, subject, number);
});

// ---------- GPA dataset ----------

const GRADE_POINTS = [4, 4, 3.67, 3.33, 3, 2.67, 2.33, 2, 1.67, 1.33, 1, 0.67, 0]; // A+ .. F

function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function buildGpaIndex(text) {
  const minYear = new Date().getFullYear() - 5;
  const byCourseProf = new Map();
  const byCourse = new Map();
  const add = (map, key, pts, n) => {
    const e = map.get(key) || { pts: 0, n: 0 };
    e.pts += pts;
    e.n += n;
    map.set(key, e);
  };
  for (const line of text.split('\n').slice(1)) {
    if (!line) continue;
    const f = splitCsv(line.replace(/\r$/, ''));
    if (Number(f[0]) < minYear) continue;
    let pts = 0;
    let n = 0;
    for (let g = 0; g < 13; g++) {
      const c = Number(f[7 + g]) || 0;
      pts += c * GRADE_POINTS[g];
      n += c;
    }
    if (!n) continue;
    const course = `${f[3]} ${f[4]}`;
    const [last, rest = ''] = f[22].split(',');
    add(byCourseProf, `${course}|${norm(last)}|${norm(rest)[0] || ''}`, pts, n);
    add(byCourse, course, pts, n);
  }
  return { byCourseProf, byCourse };
}

export const serializeGpa = (idx) => Object.fromEntries(Object.entries(idx).map(([k, m]) =>
  [k, [...m].map(([key, e]) => [key, Math.round(e.pts * 100) / 100, e.n])]));

const hydrateGpa = (json) => Object.fromEntries(Object.entries(json).map(([k, rows]) =>
  [k, new Map(rows.map(([key, pts, n]) => [key, { pts, n }]))]));

let gpaPromise = null;

// Prefers the snapshot in data/gpa.json (npm run build-data); falls back to downloading the CSV.
function loadGpa() {
  gpaPromise ||= (async () => {
    try {
      return hydrateGpa(JSON.parse(await fsp.readFile(path.join(DATA, 'gpa.json'), 'utf8')));
    } catch {}
    const file = path.join(CACHE, 'gpa.csv');
    let text;
    try {
      const st = await fsp.stat(file);
      if (Date.now() - st.mtimeMs > 30 * DAY) throw new Error('stale');
      text = await fsp.readFile(file, 'utf8');
    } catch {
      text = await getText(GPA_URL);
      await fsp.mkdir(CACHE, { recursive: true });
      await fsp.writeFile(file, text);
    }
    return buildGpaIndex(text);
  })().catch((err) => {
    gpaPromise = null; // retry on next request
    throw err;
  });
  return gpaPromise;
}

function gpaLookup(idx, subject, number, last, first) {
  const course = `${subject} ${number}`;
  const prof = `${norm(last)}|${norm(first)[0] || ''}`;
  const out = (e, scope) => ({ gpa: Math.round((e.pts / e.n) * 100) / 100, n: e.n, scope });
  const cp = idx.byCourseProf.get(`${course}|${prof}`);
  if (cp && cp.n >= 10) return out(cp, 'course+prof');
  const c = idx.byCourse.get(course);
  if (c && c.n >= 10) return out(c, 'course');
  return null;
}

// ---------- Rate My Professors (unofficial GraphQL endpoint) ----------

const RMP_QUERY = `query($q:String!){newSearch{teachers(query:{text:$q,schoolID:"${RMP_SCHOOL}"},first:20){edges{node{
  firstName lastName department avgRating avgDifficulty numRatings wouldTakeAgainPercent legacyId}}}}}`;

const rmpSearch = (last) => cached(`rmpq_${norm(last)}`, 14 * DAY, async () => {
  const body = await getText('https://www.ratemyprofessors.com/graphql', {
    method: 'POST',
    headers: { Authorization: 'Basic dGVzdDp0ZXN0', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: RMP_QUERY, variables: { q: last } }),
  });
  const edges = JSON.parse(body)?.data?.newSearch?.teachers?.edges || [];
  return edges.map((e) => e.node);
});

const words = (s) => new Set(String(s || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3));

async function rmpLookup(last, first, subjectLabel) {
  const fi = norm(first)[0] || '';
  const l = norm(last);
  const dept = words(subjectLabel);
  const cands = (await rmpSearch(last)).filter((n) => {
    const nl = norm(n.lastName);
    return (nl === l || nl.endsWith(l)) && (!fi || norm(n.firstName)[0] === fi) && n.numRatings > 0;
  });
  if (!cands.length) return null;
  const rank = (n) => ([...words(n.department)].some((w) => dept.has(w)) ? 1e6 : 0) + n.numRatings;
  cands.sort((a, b) => rank(b) - rank(a));
  const n = cands[0];
  return {
    name: `${n.firstName} ${n.lastName}`,
    department: n.department,
    rating: n.avgRating,
    difficulty: n.avgDifficulty,
    count: n.numRatings,
    wouldTakeAgain: n.wouldTakeAgainPercent >= 0 ? Math.round(n.wouldTakeAgainPercent) : null,
    url: `https://www.ratemyprofessors.com/professor/${n.legacyId}`,
  };
}

const profKey = (i) => `${norm(i.last)}|${norm(i.first)[0] || ''}`;

async function instructorInfo({ subject, subjectLabel, number, instructors }) {
  let gpaIdx = null;
  try { gpaIdx = await loadGpa(); } catch (err) { console.warn('GPA data unavailable:', err.message); }
  const out = { _course: { rmp: null, gpa: gpaIdx ? gpaLookup(gpaIdx, subject, number, '', '') : null } };
  const queue = instructors.slice();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const i = queue.shift();
      out[profKey(i)] = {
        rmp: await rmpLookup(i.last, i.first, subjectLabel).catch(() => null),
        gpa: gpaIdx ? gpaLookup(gpaIdx, subject, number, i.last, i.first) : null,
      };
    }
  }));
  return out;
}

// ---------- Building geocoding (OpenStreetMap Nominatim, 1 request/sec) ----------

const geoFile = path.join(CACHE, 'geo.json');
const geo = {};
for (const f of [path.join(DATA, 'geo.json'), geoFile]) {
  try { Object.assign(geo, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {}
}
const geoFailed = new Set();
const GEO_BATCH = 5; // serverless requests are short; the client polls for the rest

async function nominatim(name) {
  for (const q of [name, `${name}, Urbana`]) {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&bounded=1'
      + `&viewbox=-88.27,40.14,-88.19,40.07&q=${encodeURIComponent(q)}`;
    const hits = JSON.parse(await getText(url));
    if (hits.length) return { lat: Number(hits[0].lat), lon: Number(hits[0].lon) };
    await sleep(1100);
  }
  return null;
}

async function geoRequest(names) {
  const results = {};
  const todo = [];
  for (const n of names) {
    if (n in geo) results[n] = geo[n];
    else if (!geoFailed.has(n)) todo.push(n);
  }
  for (const n of todo.slice(0, GEO_BATCH)) {
    try {
      geo[n] = await nominatim(n);
      results[n] = geo[n];
      await fsp.mkdir(CACHE, { recursive: true });
      await fsp.writeFile(geoFile, JSON.stringify(geo));
    } catch {
      geoFailed.add(n);
    }
    await sleep(1100);
  }
  return { results, pending: Math.max(0, todo.length - GEO_BATCH) };
}

const readBody = (req) => new Promise((resolve, reject) => {
  if (req.body !== undefined) { // already parsed by the platform
    try { return resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}); } catch (e) { return reject(e); }
  }
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
  req.on('error', reject);
});

function check(re, v, what) {
  if (!re.test(v || '')) throw Object.assign(new Error(`bad ${what}`), { status: 400 });
  return v;
}

export async function api(req, url) {
  const q = url.searchParams;
  switch (url.pathname) {
    case '/api/subjects':
      return getSubjects(check(TERM_RE, q.get('term'), 'term'));
    case '/api/courses':
      return getCourseList(check(TERM_RE, q.get('term'), 'term'), check(/^[A-Z]{2,5}$/, q.get('subject'), 'subject'));
    case '/api/course':
      return getCourse(
        check(TERM_RE, q.get('term'), 'term'),
        check(/^[A-Z]{2,5}$/, q.get('subject'), 'subject'),
        check(/^[A-Za-z0-9]{1,5}$/, q.get('number'), 'number'),
      );
    case '/api/instructors': {
      const b = await readBody(req);
      check(/^[A-Z]{2,5}$/, b.subject, 'subject');
      check(/^[A-Za-z0-9]{1,5}$/, b.number, 'number');
      if (!Array.isArray(b.instructors)) throw Object.assign(new Error('bad instructors'), { status: 400 });
      return instructorInfo({ ...b, instructors: b.instructors.slice(0, 60) });
    }
    case '/api/geo':
      return geoRequest(q.getAll('b').slice(0, 80));
    default:
      throw Object.assign(new Error('not found'), { status: 404 });
  }
}


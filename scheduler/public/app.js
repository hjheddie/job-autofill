import {
  DAYS, DAY_NAMES, GRID_START, STEP, ROWS, emptyGrid, defaultPrefs, prepareCourse, components,
  generate, fmtTime, fmtDuration, toICS, profKey,
} from './engine.js';

const STORE = 'illini-scheduler-v1';
const COLORS = ['#13294b', '#e84a27', '#2a7f62', '#7b3fa0', '#b5651d', '#1f7aa8', '#a83255', '#5b6b2f'];
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- state ----------

const state = {
  year: 2027,
  season: 'spring',
  courses: [],    // { key, subject, number, skip, excluded, ...course data once loaded }
  grid: emptyGrid(),
  prefs: defaultPrefs(),
  saved: [],
};
let results = null;     // { schedules, problems, truncated }
let selected = 0;
let subjects = [];
const courseLists = {};
let geo = {};
let brush = 1;

const term = () => `${state.year}/${state.season}`;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (!s) return;
    Object.assign(state, { year: s.year, season: s.season, grid: s.grid || emptyGrid(), saved: s.saved || [] });
    state.prefs = { ...defaultPrefs(), ...s.prefs, w: { ...defaultPrefs().w, ...s.prefs?.w } };
    state.courses = (s.courses || []).map((c) => ({ ...c, skip: c.skip || {}, excluded: c.excluded || {} }));
  } catch {}
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      year: state.year, season: state.season, grid: state.grid, prefs: state.prefs, saved: state.saved,
      courses: state.courses.map(({ key, subject, number, skip, excluded }) => ({ key, subject, number, skip, excluded })),
    }));
  } catch {}
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 3500);
}

async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- courses ----------

const subjectLabel = (id) => subjects.find((s) => s.id === id)?.label || '';

async function fetchCourse(c) {
  c.loading = true;
  c.error = null;
  renderCourses();
  try {
    const data = prepareCourse(await api(`/api/course?term=${term()}&subject=${c.subject}&number=${c.number}`));
    Object.assign(c, data, { loading: false });
    renderCourses();
    const instructors = c.sections.flatMap((s) => s.instructors);
    const uniq = [...new Map(instructors.map((i) => [profKey(i), i])).values()];
    c.profs = await api('/api/instructors', {
      subject: c.subject, subjectLabel: subjectLabel(c.subject), number: c.number, instructors: uniq,
    });
  } catch (err) {
    c.loading = false;
    c.error = /404/.test(err.message) ? `Not offered in ${state.season} ${state.year}` : err.message;
  }
  renderCourses();
  refreshGeo();
}

async function addCourse(subject, number) {
  subject = subject.toUpperCase();
  const key = `${subject} ${number}`;
  if (state.courses.some((c) => c.key === key)) return toast(`${key} is already added`);
  const c = { key, subject, number, skip: {}, excluded: {} };
  state.courses.push(c);
  save();
  $('#courseInput').value = '';
  hideSuggest();
  await fetchCourse(c);
}

function removeCourse(key) {
  state.courses = state.courses.filter((c) => c.key !== key);
  save();
  renderCourses();
}

function renderCourses() {
  const el = $('#courses');
  if (!state.courses.length) {
    el.innerHTML = '<p class="muted small">No courses yet. Search above to add some.</p>';
    return;
  }
  el.innerHTML = state.courses.map((c, idx) => {
    const color = COLORS[idx % COLORS.length];
    const status = c.loading ? 'Loading…' : c.error ? esc(c.error) : `${c.credits || '?'} hr · ${c.sections?.length || 0} sections`;
    const open = c.openDetails ? 'open' : '';
    let body = '';
    if (c.sections && !c.loading) {
      body = components(c).map((comp) => {
        const skipped = !!c.skip[comp.key];
        return `<div class="comp">
          <div class="head"><span>${esc(comp.label)}</span>
            <label class="small"><input type="checkbox" data-act="needed" data-key="${esc(c.key)}" data-comp="${comp.key}" ${skipped ? '' : 'checked'}> needed</label></div>
          ${skipped ? '' : comp.sections.map((s) => sectionRow(c, s)).join('')}
        </div>`;
      }).join('');
    }
    return `<details class="course" data-key="${esc(c.key)}" ${open}>
      <summary><i style="width:10px;height:10px;border-radius:50%;background:${color}"></i>
        <div class="name"><b>${esc(c.key)}</b> <span class="muted small">${esc(c.title || '')}</span><span class="small muted">${status}</span></div>
        <button class="x" data-act="remove" data-key="${esc(c.key)}" title="Remove">✕</button></summary>
      <div class="body">${body}</div></details>`;
  }).join('');
}

function profBadges(c, inst) {
  const p = c.profs?.[profKey(inst)];
  let out = '';
  if (p?.rmp) {
    out += `<a class="tag" href="${esc(p.rmp.url)}" target="_blank" rel="noopener" title="${p.rmp.count} ratings, ${p.rmp.difficulty} difficulty">★ ${p.rmp.rating.toFixed(1)}</a>`;
  } else if (p) out += '<span class="tag">no RMP</span>';
  if (p?.gpa) out += `<span class="tag" title="${p.gpa.n} grades, ${p.gpa.scope}">GPA ${p.gpa.gpa.toFixed(2)}</span>`;
  return out;
}

function meetingText(m) {
  if (m.start == null) return 'Time TBA / online';
  return `${m.days} ${fmtTime(m.start)}–${fmtTime(m.end)}${m.building ? ` · ${m.building}` : ''}`;
}

function sectionRow(c, s) {
  const profs = s.instructors.map((i) => `${esc(i.last)}, ${esc(i.first)} ${profBadges(c, i)}`).join('<br>');
  return `<label class="sec"><input type="checkbox" data-act="include" data-key="${esc(c.key)}" data-crn="${s.crn}" ${c.excluded[s.crn] ? '' : 'checked'}>
    <div><b>${esc(s.number)}</b> <span class="muted">CRN ${s.crn}</span><br>
    ${s.meetings.map((m) => esc(meetingText(m))).join('<br>')}<br>${profs || '<span class="muted">Staff</span>'}
    ${s.notes ? `<div class="meta">${esc(s.notes.slice(0, 160))}</div>` : ''}</div></label>`;
}

// ---------- course search ----------

function hideSuggest() { $('#suggest').hidden = true; }

async function updateSuggest() {
  const q = $('#courseInput').value.trim();
  const box = $('#suggest');
  if (!q) return hideSuggest();
  const m = /^([a-z]*)\s*(.*)$/i.exec(q);
  const subj = m[1].toUpperCase();
  const rest = m[2].trim().toLowerCase();
  let items = [];
  if (subj && subjects.some((s) => s.id === subj)) {
    const k = `${term()}|${subj}`;
    courseLists[k] ||= await api(`/api/courses?term=${term()}&subject=${subj}`).catch(() => []);
    items = courseLists[k]
      .filter((c) => !rest || c.number.startsWith(rest) || c.title.toLowerCase().includes(rest))
      .slice(0, 30)
      .map((c) => ({ html: `<b>${esc(subj)} ${esc(c.number)}</b> ${esc(c.title)}`, subject: subj, number: c.number }));
  } else if (subj) {
    items = subjects.filter((s) => s.id.startsWith(subj) || s.label.toUpperCase().includes(q.toUpperCase()))
      .slice(0, 12).map((s) => ({ html: `<b>${esc(s.id)}</b> ${esc(s.label)}`, fill: `${s.id} ` }));
  }
  if ($('#courseInput').value.trim() !== q) return; // stale
  box.innerHTML = items.map((it, i) => `<button data-i="${i}">${it.html}</button>`).join('')
    || '<div class="muted small" style="padding:8px 10px">No matches</div>';
  box._items = items;
  box.hidden = false;
}

// ---------- preferences ----------

const hourOptions = (zeroLabel) => [`<option value="0">${zeroLabel}</option>`]
  .concat(Array.from({ length: 15 }, (_, i) => `<option value="${(7 + i) * 60}">${fmtTime((7 + i) * 60)}</option>`)).join('');

function renderPrefs() {
  const p = state.prefs;
  const slider = (path, label, min = 0, max = 10, hint = '') => {
    const v = path.split('.').reduce((o, k) => o[k], p);
    return `<div class="field" title="${esc(hint)}"><span class="lbl">${label}</span>
      <input type="range" data-pref="${path}" min="${min}" max="${max}" value="${v}"><span class="val">${v}</span></div>`;
  };
  $('#prefs').innerHTML = `
    <div class="field"><span class="lbl">No class before</span><select data-pref="earliest">${hourOptions('No limit')}</select></div>
    <div class="field"><span class="lbl">No class after</span><select data-pref="latest">${hourOptions('No limit')}</select></div>
    <div class="field"><span class="lbl">Min gap (min)</span><input type="number" data-pref="minGap" min="0" max="120" step="5" value="${p.minGap}"></div>
    <div class="field"><span class="lbl">Max gap (min)</span><input type="number" data-pref="maxGap" min="0" max="600" step="10" value="${p.maxGap}" title="0 = no limit"></div>
    <div class="field"><span class="lbl">Max back-to-back (h)</span><input type="number" data-pref="maxConsecHours" min="0" max="12" step="0.5" value="${p.maxConsecHours}" title="0 = no limit"></div>
    <div class="field"><span class="lbl">Walking time</span><select data-pref="walking">
      <option value="off">Ignore</option><option value="penalize">Penalize tight</option><option value="enforce">Require</option></select></div>
    <div class="field"><span class="lbl">Days off</span><div class="days">${DAYS.map((d) =>
      `<label><input type="checkbox" data-day="${d}" ${p.daysOff.includes(d) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div></div>
    <div class="field"><span class="lbl">Min RMP rating</span><input type="number" data-pref="minRmp" min="0" max="5" step="0.1" value="${p.minRmp}" title="Drops sections whose instructor is rated below this. 0 = off"></div>
    <hr>
    <h2>What matters (0–10)</h2>
    ${slider('w.rmp', 'RMP rating', 0, 10, 'Prefer better-rated professors')}
    ${slider('w.gpa', 'Grade average', 0, 10, 'Prefer instructors/courses with higher average GPA')}
    ${slider('w.soft', 'Keep preferred free', 0, 10, 'Avoid classes in the yellow cells on the Breaks tab')}
    ${slider('w.compact', 'Short gaps', 0, 10, 'Less idle time between classes')}
    ${slider('w.days', 'Fewer days', 0, 10, 'Fewer days on campus')}
    ${slider('w.start', 'Earlier ⟷ later', -10, 10, 'Negative prefers early classes, positive prefers late')}`;
  for (const k of ['earliest', 'latest', 'walking']) $(`#prefs [data-pref="${k}"]`).value = p[k];
}

function onPrefInput(e) {
  const el = e.target;
  if (el.dataset.day) {
    const days = new Set(state.prefs.daysOff);
    if (el.checked) days.add(el.dataset.day); else days.delete(el.dataset.day);
    state.prefs.daysOff = DAYS.filter((d) => days.has(d));
  } else if (el.dataset.pref) {
    const keys = el.dataset.pref.split('.');
    const last = keys.pop();
    const obj = keys.reduce((o, k) => o[k], state.prefs);
    obj[last] = el.tagName === 'SELECT' && last === 'walking' ? el.value : Number(el.value) || 0;
    if (el.type === 'range') el.nextElementSibling.textContent = el.value;
  }
  save();
}

// ---------- calendar rendering ----------

function timeAxis() {
  return `<div class="times">${Array.from({ length: 15 }, (_, h) =>
    `<span style="top:${h * 2 * 20}px">${fmtTime((7 + h) * 60).replace(':00', '')}</span>`).join('')}</div>`;
}

function gridCells(day, interactive) {
  const col = state.grid[day] || [];
  return Array.from({ length: ROWS }, (_, i) =>
    `<div class="cell ${col[i] === 1 ? 'h' : col[i] === 2 ? 's' : ''}" ${interactive ? `data-d="${day}" data-i="${i}"` : ''}></div>`).join('');
}

function renderBreaks() {
  const el = $('#tab-breaks');
  el.innerHTML = `
    <div class="brush">
      <b>Paint:</b>
      <button class="ghost ${brush === 1 ? 'on' : ''}" data-brush="1">Blocked</button>
      <button class="ghost ${brush === 2 ? 'on' : ''}" data-brush="2">Prefer free</button>
      <button class="ghost ${brush === 0 ? 'on' : ''}" data-brush="0">Erase</button>
      <button class="ghost" data-act="clearGrid">Clear all</button>
      <span class="muted small legend"><i style="background:var(--hard)"></i>never schedule here
        <i style="background:var(--soft);margin-left:10px"></i>avoid if possible</span>
    </div>
    <div class="cal paint" id="breakGrid">
      <div></div>${DAYS.map((d) => `<div class="hdr">${DAY_NAMES[d]}</div>`).join('')}
      ${timeAxis()}${DAYS.map((d) => `<div class="col">${gridCells(d, true)}</div>`).join('')}
    </div>
    <div class="quick">
      <b>Quick add:</b>
      <span class="days">${DAYS.map((d) => `<label><input type="checkbox" class="qd" value="${d}" checked><span>${d}</span></label>`).join('')}</span>
      <select id="qs">${hourOptions('').replace('<option value="0"></option>', '')}</select> to
      <select id="qe">${hourOptions('').replace('<option value="0"></option>', '')}</select>
      <button class="ghost" id="qadd">Apply paint brush</button>
      <button class="ghost" data-quick="lunch">Lunch 12–1</button>
      <button class="ghost" data-quick="morning">No 8 AMs</button>
    </div>
    <p class="muted small">Blocked times are hard rules. "Prefer free" times only lower a schedule's score (weight set under Preferences).</p>`;
  $('#qs').value = 12 * 60;
  $('#qe').value = 13 * 60;
}

function paintRange(days, start, end, value) {
  for (const d of days) {
    for (let i = 0; i < ROWS; i++) {
      const cs = GRID_START + i * STEP;
      if (cs >= start && cs + STEP <= end) state.grid[d][i] = value;
    }
  }
  save();
  renderBreaks();
}

let painting = false;
function paintAt(e) {
  const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cell[data-d]');
  if (!cell) return;
  const arr = state.grid[cell.dataset.d];
  const i = Number(cell.dataset.i);
  if (arr[i] === brush) return;
  arr[i] = brush;
  cell.className = `cell ${brush === 1 ? 'h' : brush === 2 ? 's' : ''}`;
}

function calendar(blocks, colorOf) {
  const extra = [...new Set(blocks.map((b) => b.day))].filter((d) => !DAYS.includes(d));
  const days = [...DAYS, ...extra];
  const px = 20 / STEP;
  return `<div class="cal" style="--cols:${days.length}">
    <div></div>${days.map((d) => `<div class="hdr">${DAY_NAMES[d]}</div>`).join('')}
    ${timeAxis()}${days.map((d) => `<div class="col">${gridCells(d, false)}${blocks.filter((b) => b.day === d).map((b) => {
      const top = Math.max(0, (b.start - GRID_START) * px);
      const h = Math.max(14, (b.end - b.start) * px - 1);
      return `<div class="block" style="top:${top}px;height:${h}px;background:${colorOf(b.courseKey)}">
        <b>${esc(b.courseKey)} ${esc(b.type)}</b>${fmtTime(b.start)}–${fmtTime(b.end).replace(/ [AP]M/, '')}<br>${esc(b.bld)}</div>`;
    }).join('')}</div>`).join('')}</div>`;
}

// ---------- results ----------

function scheduleBlocks(s) {
  return s.sections.flatMap((x) => x.sec.meetings.flatMap((m) =>
    m.start == null ? [] : [...m.days].map((day) => ({
      day, start: m.start, end: m.end, courseKey: x.courseKey, type: x.sec.type, bld: m.building,
    }))));
}

function colorFor(s) {
  const keys = [...new Set(s.sections.map((x) => x.courseKey))];
  return (k) => COLORS[(state.courses.findIndex((c) => c.key === k) >= 0
    ? state.courses.findIndex((c) => c.key === k) : keys.indexOf(k)) % COLORS.length];
}

function summary(s) {
  const m = s.metrics;
  const days = DAYS.filter((d) => m.dayList.includes(d)).join('') + m.dayList.filter((d) => !DAYS.includes(d)).join('');
  return `${days} · ${m.credits} hr · gaps ${fmtDuration(m.gapMin)} · RMP ${m.rmp.toFixed(1)} · GPA ${m.gpa.toFixed(2)}`;
}

function detail(s, profSource, savedIdx = -1) {
  const m = s.metrics;
  const rows = s.sections.map((x) => {
    const src = profSource(x.courseKey);
    const profs = x.sec.instructors.map((i) => `${esc(i.last)}, ${esc(i.first)} ${profBadges({ profs: src }, i)}`).join('<br>') || 'Staff';
    return `<tr><td><b>${esc(x.courseKey)}</b><br><span class="muted">${esc(x.sec.typeName)}</span></td>
      <td>${esc(x.sec.number)}<br><span class="muted">${x.sec.crn}</span></td>
      <td>${x.sec.meetings.map((mt) => esc(meetingText(mt))).join('<br>')}</td><td>${profs}</td></tr>`;
  }).join('');
  const notes = [];
  if (m.rmpTotal && m.rmpKnown < m.rmpTotal) notes.push(`${m.rmpTotal - m.rmpKnown} instructor(s) have no RMP rating (counted as average).`);
  if (m.walkTight) notes.push(`${m.walkTight} tight walk(s) between buildings.`);
  if (m.softMin) notes.push(`${fmtDuration(m.softMin)} overlaps your "prefer free" times.`);
  return `<div class="actions">
      ${savedIdx < 0 ? '<button class="ghost" data-act="save">☆ Save</button>' : `<button class="ghost" data-act="unsave" data-i="${savedIdx}">Remove from saved</button>`}
      <button class="ghost" data-act="ics" data-i="${savedIdx}">Export .ics</button>
      <button class="ghost" data-act="crns" data-i="${savedIdx}">Copy CRNs</button>
      <span class="muted small">${summary(s)}</span></div>
    ${notes.length ? `<div class="notice small">${notes.map(esc).join('<br>')}</div>` : ''}
    ${calendar(scheduleBlocks(s), colorFor(s))}
    <table class="sched"><thead><tr><th>Course</th><th>Sec / CRN</th><th>Meets</th><th>Instructor</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderResults() {
  const el = $('#tab-results');
  $('#resultCount').textContent = results?.schedules.length ? `(${results.schedules.length})` : '';
  if (!results) {
    el.innerHTML = '<p class="muted">Add courses, set your breaks, then press <b>Generate schedules</b>.</p>';
    return;
  }
  if (!results.schedules.length) {
    el.innerHTML = `<div class="notice">${results.problems.map(esc).join('<br>')}</div>`;
    return;
  }
  const list = results.schedules.map((s, i) => `<button class="rcard ${i === selected ? 'on' : ''}" data-act="pick" data-i="${i}">
    <div class="t"><span>#${i + 1}</span><span class="muted small">score ${s.score.toFixed(1)}</span></div>
    <div class="small muted">${summary(s)}</div></button>`).join('');
  el.innerHTML = `${results.truncated ? '<div class="notice small">Too many combinations to check them all; showing the best of those searched. Narrow the sections or add constraints for a full search.</div>' : ''}
    <div class="results"><div class="rlist">${list}</div>
    <div>${detail(results.schedules[selected], (k) => state.courses.find((c) => c.key === k)?.profs)}</div></div>`;
}

function renderSaved() {
  const el = $('#tab-saved');
  $('#savedCount').textContent = state.saved.length ? `(${state.saved.length})` : '';
  if (!state.saved.length) {
    el.innerHTML = '<p class="muted">Nothing saved yet. Use ☆ Save on a schedule.</p>';
    return;
  }
  el.innerHTML = state.saved.map((s, i) => `<h3 style="margin:18px 0 0">${esc(s.label)}</h3>${detail(s, (k) => s.profsSnapshot?.[k], i)}`).join('<hr>');
}

// ---------- actions ----------

function runGenerate() {
  if (state.courses.some((c) => c.loading)) return toast('Still loading course data…');
  const ready = state.courses.filter((c) => c.sections);
  const broken = state.courses.filter((c) => c.error);
  if (broken.length) toast(`Skipping ${broken.map((c) => c.key).join(', ')} (not available this term)`);
  switchTab('results');
  $('#tab-results').innerHTML = '<p class="muted">Searching…</p>';
  setTimeout(() => {
    results = generate(ready, state.prefs, state.grid, geo);
    selected = 0;
    renderResults();
  }, 20);
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function scheduleFor(i) {
  return i >= 0 ? state.saved[i] : results.schedules[selected];
}

function onContentClick(e) {
  const b = e.target.closest('[data-act],[data-brush],[data-quick]');
  if (!b) return;
  if (b.dataset.brush != null) { brush = Number(b.dataset.brush); return renderBreaks(); }
  if (b.dataset.quick === 'lunch') return paintRange(DAYS, 12 * 60, 13 * 60, 1);
  if (b.dataset.quick === 'morning') return paintRange(DAYS, GRID_START, 9 * 60, 1);
  const i = Number(b.dataset.i);
  switch (b.dataset.act) {
    case 'clearGrid': state.grid = emptyGrid(); save(); renderBreaks(); break;
    case 'pick': selected = i; renderResults(); break;
    case 'save': {
      const s = structuredClone(results.schedules[selected]);
      s.label = `Saved ${new Date().toLocaleString()}`;
      s.profsSnapshot = Object.fromEntries(state.courses.map((c) => [c.key, c.profs || {}]));
      state.saved.unshift(s);
      save(); renderSaved(); toast('Saved');
      break;
    }
    case 'unsave': state.saved.splice(i, 1); save(); renderSaved(); break;
    case 'ics': download('schedule.ics', toICS(scheduleFor(i)), 'text/calendar'); break;
    case 'crns': {
      const text = scheduleFor(i).sections.map((x) => x.sec.crn).join(', ');
      navigator.clipboard?.writeText(text).then(() => toast(`Copied CRNs: ${text}`), () => toast(text));
      break;
    }
  }
}

function switchTab(name) {
  for (const t of document.querySelectorAll('.tabs button')) t.classList.toggle('on', t.dataset.tab === name);
  for (const n of ['breaks', 'results', 'saved']) $(`#tab-${n}`).hidden = n !== name;
}

// Walking times use real building locations, geocoded by the server in the background.
async function refreshGeo(attempt = 0) {
  const names = [...new Set(state.courses.flatMap((c) => (c.sections || []).flatMap((s) => s.meetings.map((m) => m.building))))]
    .filter(Boolean);
  if (!names.length) return;
  try {
    const r = await api(`/api/geo?${names.map((n) => `b=${encodeURIComponent(n)}`).join('&')}`);
    for (const [n, v] of Object.entries(r.results)) if (v) geo[n] = v;
    if (r.pending && attempt < 60) setTimeout(() => refreshGeo(attempt + 1), 4000);
  } catch {}
}

async function loadTerm() {
  $('#season').value = state.season;
  $('#year').value = state.year;
  subjects = await api(`/api/subjects?term=${term()}`).catch(() => []);
  await Promise.all(state.courses.map(fetchCourse));
}

// ---------- init ----------

load();
renderPrefs();
renderBreaks();
renderResults();
renderSaved();
renderCourses();

$('#courses').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-act="remove"]');
  if (rm) { e.preventDefault(); removeCourse(rm.dataset.key); }
});
$('#courses').addEventListener('change', (e) => {
  const el = e.target;
  const c = state.courses.find((x) => x.key === el.dataset.key);
  if (!c) return;
  if (el.dataset.act === 'needed') c.skip[el.dataset.comp] = !el.checked;
  if (el.dataset.act === 'include') c.excluded[el.dataset.crn] = !el.checked;
  save();
  renderCourses();
});
$('#courses').addEventListener('toggle', (e) => {
  const c = state.courses.find((x) => x.key === e.target.dataset?.key);
  if (c) c.openDetails = e.target.open;
}, true);

$('#prefs').addEventListener('input', onPrefInput);
$('#prefs').addEventListener('change', onPrefInput);
$('#generate').addEventListener('click', runGenerate);
document.querySelector('.tabs').addEventListener('click', (e) => {
  if (e.target.dataset.tab) switchTab(e.target.dataset.tab);
});
for (const id of ['#tab-breaks', '#tab-results', '#tab-saved']) $(id).addEventListener('click', onContentClick);

$('#tab-breaks').addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#breakGrid')) return;
  painting = true;
  paintAt(e);
});
window.addEventListener('pointermove', (e) => { if (painting) paintAt(e); });
window.addEventListener('pointerup', () => { if (painting) { painting = false; save(); } });
$('#tab-breaks').addEventListener('click', (e) => {
  if (e.target.id !== 'qadd') return;
  const days = [...document.querySelectorAll('.qd:checked')].map((x) => x.value);
  paintRange(days, Number($('#qs').value), Number($('#qe').value), brush);
});

const courseInput = $('#courseInput');
courseInput.addEventListener('input', updateSuggest);
courseInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideSuggest();
  if (e.key !== 'Enter') return;
  const m = /^([a-z]{2,5})\s*(\d{1,3}[a-z]?)$/i.exec(courseInput.value.trim());
  if (m) addCourse(m[1], m[2].toUpperCase());
});
$('#suggest').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  const it = b && $('#suggest')._items[Number(b.dataset.i)];
  if (!it) return;
  if (it.fill) { courseInput.value = it.fill; courseInput.focus(); updateSuggest(); }
  else addCourse(it.subject, it.number);
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) hideSuggest(); });

$('#season').addEventListener('change', (e) => { state.season = e.target.value; save(); loadTerm(); });
$('#year').addEventListener('change', (e) => { state.year = Number(e.target.value) || state.year; save(); loadTerm(); });

loadTerm();

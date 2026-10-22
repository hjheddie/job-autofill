import {
  DAYS, DAY_NAMES, GRID_START, STEP, ROWS, emptyGrid, defaultPrefs, prepareCourse, components,
  generate, alternatives, buildSchedule, walkMinutes, transitions, fmtTime, fmtDuration, toICS, profKey,
} from './engine.js';
import { checkPrereq, normCodes } from './prereq.js';

const STORE = 'illini-scheduler-v1';
const COLORS = ['#13294b', '#e84a27', '#2a7f62', '#7b3fa0', '#b5651d', '#1f7aa8', '#a83255', '#5b6b2f'];
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => `${Math.round(v * 100)}%`;

// ---------- state ----------

const state = {
  year: 2027,
  season: 'spring',
  courses: [],    // { key, subject, number, skip, excluded, pins, links, ...course data once loaded }
  grid: emptyGrid(),
  prefs: defaultPrefs(),
  saved: [],
  taken: '',
  reg: { time: '', done: {}, plan: 'cur' },
};
let results = null;     // { schedules, problems, truncated }
let selected = 0;
let subjects = [];
const courseLists = {};
let geo = {};
let brush = 1;
const compareSel = [];
let lastSwaps = null;
let pendingShare = null;

const term = () => `${state.year}/${state.season}`;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (s) applyState(s);
  } catch {}
}

function applyState(s) {
  Object.assign(state, {
    year: s.year ?? state.year,
    season: s.season ?? state.season,
    grid: s.grid || emptyGrid(),
    saved: s.saved || [],
    taken: s.taken || '',
    reg: { time: '', done: {}, plan: 'cur', ...s.reg },
  });
  state.prefs = { ...defaultPrefs(), ...s.prefs, w: { ...defaultPrefs().w, ...s.prefs?.w } };
  state.courses = (s.courses || []).map((c) => ({
    key: c.key, subject: c.subject, number: c.number,
    skip: c.skip || {}, excluded: c.excluded || {}, pins: c.pins || {}, links: c.links || {},
  }));
}

function snapshot() {
  return {
    year: state.year, season: state.season, grid: state.grid, prefs: state.prefs, saved: state.saved,
    taken: state.taken, reg: state.reg,
    courses: state.courses.map(({ key, subject, number, skip, excluded, pins, links }) => ({ key, subject, number, skip, excluded, pins, links })),
  };
}

function save() {
  try { localStorage.setItem(STORE, JSON.stringify(snapshot())); } catch {}
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

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const copy = (text, msg) => navigator.clipboard?.writeText(text).then(() => toast(msg || 'Copied'), () => toast(text));

const takenSet = () => new Set(normCodes(state.taken));
const readyCourses = () => state.courses.filter((c) => c.sections);

// ---------- share links & backup ----------

const b64 = {
  enc: (o) => {
    const bytes = new TextEncoder().encode(JSON.stringify(o));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec: (s) => {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  },
};

function shareLink(schedule) {
  const payload = {
    t: term(),
    c: state.courses.map((c) => c.key),
    g: DAYS.map((d) => state.grid[d].join('')),
    p: state.prefs,
    tk: state.taken,
    s: schedule ? schedule.sections.map((x) => x.sec.crn) : [],
  };
  return `${location.origin}${location.pathname}#share=${b64.enc(payload)}`;
}

// A share link is decoded on load but only applied once the user accepts the banner.
let shareOffer = null;

function readShare() {
  if (!location.hash.startsWith('#share=')) return;
  try {
    shareOffer = b64.dec(location.hash.slice(7));
  } catch {
    toast('That share link could not be read');
  }
  history.replaceState(null, '', location.pathname);
}

function showShareBanner() {
  if (!shareOffer) return;
  const [year, season] = shareOffer.t.split('/');
  const banner = document.createElement('div');
  banner.className = 'notice';
  banner.id = 'shareBanner';
  banner.innerHTML = `<b>Shared plan:</b> ${shareOffer.c.length} courses (${esc(season)} ${esc(year)})${shareOffer.s.length ? `, ${shareOffer.s.length} sections` : ''}.
    Loading it replaces your current courses, breaks and preferences.
    <button class="ghost" id="shareLoad">Load plan</button> <button class="ghost" id="shareDismiss">Dismiss</button>`;
  $('.layout').before(banner);
  $('#shareDismiss').addEventListener('click', () => { shareOffer = null; banner.remove(); });
  $('#shareLoad').addEventListener('click', async () => {
    const p = shareOffer;
    shareOffer = null;
    banner.remove();
    pendingShare = p;
    applyState({
      year: Number(year), season, taken: p.tk || '', prefs: p.p, saved: state.saved, reg: state.reg,
      grid: Object.fromEntries(DAYS.map((d, i) => [d, [...(p.g?.[i] || '')].map(Number)])),
      courses: p.c.map((key) => { const [subject, number] = key.split(' '); return { key, subject, number }; }),
    });
    save();
    renderPrefs(); renderBreaks(); renderCourses();
    $('#taken').value = state.taken;
    await loadTerm();
    finishShare();
  });
}

// ---------- generating (in a worker so the page stays responsive) ----------

let worker = null;
let reqId = 0;

function generateAsync(courses) {
  const payload = { courses, prefs: state.prefs, grid: state.grid, geo };
  const inline = () => generate(courses, state.prefs, state.grid, geo);
  if (typeof Worker === 'undefined') return Promise.resolve(inline());
  return new Promise((resolve) => {
    try {
      worker ||= new Worker('worker.js', { type: 'module' });
      const id = ++reqId;
      const done = (fn) => { worker.removeEventListener('message', onMsg); worker.removeEventListener('error', onErr); fn(); };
      const onMsg = (e) => { if (e.data.id === id) done(() => resolve(e.data.result)); };
      const onErr = () => { worker = null; done(() => resolve(inline())); };
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', onErr);
      worker.postMessage({ id, ...payload });
    } catch {
      worker = null;
      resolve(inline());
    }
  });
}

// ---------- courses ----------

const subjectLabel = (id) => subjects.find((s) => s.id === id)?.label || '';

async function fetchCourse(c) {
  c.loading = true;
  c.error = null;
  renderCourses();
  try {
    const data = prepareCourse(await api(`/api/course?term=${term()}&subject=${c.subject}&number=${c.number}`));
    const { skip, excluded, pins, links } = c;
    Object.assign(c, data, { loading: false });
    Object.assign(c, { skip: skip || {}, excluded: excluded || {}, pins: pins || {}, links: links || {} });
    renderCourses();
    const uniq = [...new Map(c.sections.flatMap((s) => s.instructors).map((i) => [profKey(i), i])).values()];
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
  const c = { key, subject, number, skip: {}, excluded: {}, pins: {}, links: {} };
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

function prereqHtml(prereq) {
  if (!prereq) return '';
  const taken = takenSet();
  let chips = '';
  if (taken.size) {
    const r = checkPrereq(prereq, taken);
    chips = r.ok
      ? '<span class="tag ok">prerequisites look met</span>'
      : r.unmet.map((alts) => `<span class="tag warn" title="None of these are in your taken list">needs ${esc(alts.join(' / '))}</span>`).join('');
    if (r.other.length) chips += `<span class="tag" title="${esc(r.other.join('; '))}">+ other requirement</span>`;
  }
  return `<div class="prereq"><span class="muted">Prereq:</span> ${esc(prereq)} ${chips}</div>`;
}

const selectedCount = (c) => (c.sections || []).filter((s) => !c.excluded[s.crn]).length;

function renderCourses() {
  const el = $('#courses');
  renderSections();
  if (!state.courses.length) {
    el.innerHTML = '<p class="muted small">No courses yet. Search above, or use the Browse courses tab.</p>';
    return;
  }
  el.innerHTML = state.courses.map((c, idx) => {
    const color = COLORS[idx % COLORS.length];
    const locks = Object.keys(c.pins || {}).length;
    const status = c.loading ? 'Loading…' : c.error ? esc(c.error)
      : `${c.credits || '?'} hr · ${selectedCount(c)}/${c.sections?.length || 0} sections selected${locks ? ` · ${locks} locked` : ''}`;
    return `<div class="course" data-key="${esc(c.key)}">
      <div class="chead"><i style="width:10px;height:10px;border-radius:50%;background:${color}"></i>
        <div class="name"><b>${esc(c.key)}</b> <span class="muted small">${esc(c.title || '')}</span><span class="small muted">${status}</span></div>
        <button class="x" data-act="remove" data-key="${esc(c.key)}" title="Remove">✕</button></div>
      ${c.sections && !c.loading ? prereqHtml(c.prereq) : ''}</div>`;
  }).join('') + '<button class="ghost small" style="margin-top:8px" data-act="gotoSections">Choose sections &amp; professors →</button>';
}

// Every instructor of a course with the sections they teach (co-taught sections appear under each).
function profGroups(c) {
  const groups = new Map();
  for (const s of c.sections) {
    const insts = s.instructors.length ? s.instructors : [null];
    for (const i of insts) {
      const key = i ? profKey(i) : '_staff';
      if (!groups.has(key)) groups.set(key, { key, inst: i, sections: [] });
      groups.get(key).sections.push(s);
    }
  }
  return [...groups.values()].sort((a, b) => (a.key === '_staff') - (b.key === '_staff') || a.key.localeCompare(b.key));
}

function renderSections() {
  const el = $('#tab-sections');
  if (!state.courses.length) {
    el.innerHTML = '<p class="muted">Add courses first. Every section and professor appears here, all selected by default.</p>';
    return;
  }
  el.innerHTML = '<p class="muted small">Everything is selected by default. Untick sections or professors you do not want; schedules are built only from what is ticked.</p>'
    + state.courses.map((c, idx) => {
      if (!c.sections) {
        return `<div class="panelbox"><b>${esc(c.key)}</b> <span class="muted">${c.loading ? 'Loading…' : esc(c.error || '')}</span></div>`;
      }
      const attrs = `data-key="${esc(c.key)}"`;
      const profs = profGroups(c).map((p) => {
        const on = p.sections.filter((s) => !c.excluded[s.crn]).length;
        const state3 = on === 0 ? 0 : on === p.sections.length ? 1 : 2;
        const label = p.inst ? `${esc(p.inst.first)} ${esc(p.inst.last)}` : 'Staff / TBA';
        return `<label class="prof"><input type="checkbox" data-act="profToggle" data-tri="${state3}" ${attrs} data-prof="${esc(p.key)}" ${state3 === 1 ? 'checked' : ''}>
          <span>${label}</span> ${p.inst ? profBadges(c, p.inst) : ''}<span class="muted small">${on}/${p.sections.length}</span></label>`;
      }).join('');
      const comps = components(c).map((comp) => {
        const skipped = !!c.skip[comp.key];
        return `<div class="comp">
          <div class="head"><span>${esc(comp.label)} <span class="muted small">(${comp.sections.length})</span></span>
            <span><button class="mini" data-act="selComp" data-val="1" ${attrs} data-comp="${comp.key}">All</button><button class="mini" data-act="selComp" data-val="0" ${attrs} data-comp="${comp.key}">None</button>
            <label class="small"><input type="checkbox" data-act="needed" ${attrs} data-comp="${comp.key}" ${skipped ? '' : 'checked'}> needed</label></span></div>
          ${skipped ? '' : comp.sections.map((s) => sectionRow(c, s)).join('')}
        </div>`;
      }).join('');
      return `<details class="panelbox" ${attrs} ${c.openSections === false ? '' : 'open'}>
        <summary><b>${esc(c.key)}</b> ${esc(c.title)} <span class="muted small">· ${selectedCount(c)}/${c.sections.length} sections selected</span>
          <span style="float:right"><button class="mini" data-act="selAll" data-val="1" ${attrs}>Select all</button><button class="mini" data-act="selAll" data-val="0" ${attrs}>Select none</button></span></summary>
        <div class="profs"><div class="small muted">Professors</div>${profs}</div>${comps}</details>`;
    }).join('');
  for (const box of el.querySelectorAll('[data-tri="2"]')) box.indeterminate = true;
}

function profBadges(c, inst) {
  const p = c.profs?.[profKey(inst)];
  let out = '';
  if (p?.rmp) {
    out += `<a class="tag" href="${esc(p.rmp.url)}" target="_blank" rel="noopener" title="${p.rmp.count} ratings; difficulty ${p.rmp.difficulty}/5${p.rmp.wouldTakeAgain != null ? `; ${p.rmp.wouldTakeAgain}% would take again` : ''}">★ ${p.rmp.rating.toFixed(1)} · diff ${p.rmp.difficulty.toFixed(1)}</a>`;
  } else if (p) out += '<span class="tag">no RMP</span>';
  if (p?.gpa) {
    out += `<span class="tag" title="${p.gpa.n} grades (${p.gpa.scope}); ${pct(p.gpa.wRate ?? 0)} withdraw">GPA ${p.gpa.gpa.toFixed(2)}${p.gpa.aRate != null ? ` · A ${pct(p.gpa.aRate)}` : ''}</span>`;
  }
  return out;
}

function meetingText(m) {
  if (m.start == null) return 'Time TBA / online';
  return `${m.days} ${fmtTime(m.start)}–${fmtTime(m.end)}${m.building ? ` · ${m.building}${m.room ? ` ${m.room}` : ''}` : ''}`;
}

function closeness(meters) {
  if (meters == null) return 'unknown';
  if (meters === 0) return 'same building';
  if (meters < 150) return 'next door';
  if (meters < 400) return 'close';
  if (meters < 800) return 'a walk';
  return 'far';
}

function transitionsHtml(s) {
  const t = transitions(s, geo);
  if (!t.length) return '';
  const rows = t.map((x) => {
    const cls = !x.known ? '' : x.slack < 0 ? 'down' : x.slack < 5 ? 'warn' : 'up';
    const dist = x.meters == null ? 'location not found yet' : x.meters === 0 ? '–' : `${Math.round(x.meters)} m`;
    return `<tr><td>${DAY_NAMES[x.day]}</td>
      <td>${esc(x.from.course)} <span class="muted">${esc(x.from.bld)} ${esc(x.from.room)}</span> → ${esc(x.to.course)} <span class="muted">${esc(x.to.bld)} ${esc(x.to.room)}</span></td>
      <td>${closeness(x.meters)} <span class="muted">${dist}</span></td><td>${x.walk} min</td><td>${x.gap} min</td>
      <td class="delta ${cls}">${!x.known ? '–' : x.slack < 0 ? `${-x.slack} min late` : `${x.slack} min spare`}</td></tr>`;
  }).join('');
  return `<details class="panelbox"><summary><b>Between classes</b> <span class="muted small">how close back-to-back classes are, and the time left after walking</span></summary>
    <table class="sched"><thead><tr><th>Day</th><th>From → to</th><th>Closeness</th><th>Walk</th><th>Gap</th><th>Slack</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

function sectionRow(c, s) {
  const profs = s.instructors.map((i) => `${esc(i.last)}, ${esc(i.first)} ${profBadges(c, i)}`).join('<br>');
  const pinned = c.pins[s.comp] === s.crn;
  const hasSecondary = components(c).length > 1;
  const attrs = `data-key="${esc(c.key)}" data-crn="${s.crn}" data-comp="${s.comp}"`;
  const linkBtn = s.comp === 'PRI' && hasSecondary
    ? `<button class="mini ${c.links[s.crn] ? 'on' : ''}" data-act="linkedit" ${attrs} title="Limit which discussions/labs can go with this lecture">${c.links[s.crn] ? 'Linked ✓' : 'Link…'}</button>` : '';
  return `<div class="sec ${pinned ? 'locked' : ''}">
    <input type="checkbox" data-act="include" ${attrs} ${c.excluded[s.crn] ? '' : 'checked'} aria-label="Include section ${esc(s.number)}">
    <div><b>${esc(s.number)}</b> <span class="muted">CRN ${s.crn}</span>
    <button class="mini ${pinned ? 'on' : ''}" data-act="${pinned ? 'unpin' : 'pin'}" ${attrs} title="Make every schedule use this section">${pinned ? '🔓 Unlock' : '🔒 Lock'}</button>${linkBtn}<br>
    ${s.meetings.map((m) => esc(meetingText(m))).join('<br>')}<br>${profs || '<span class="muted">Staff</span>'}
    ${s.title ? `<div class="meta">${esc(s.title)}</div>` : ''}
    ${s.notes ? `<div class="meta">${esc(s.notes.slice(0, 160))}</div>` : ''}
    ${c.linkEdit === s.crn ? linkEditor(c, s) : ''}</div></div>`;
}

function linkEditor(c, p) {
  return `<div class="linkbox">${components(c).filter((k) => k.key !== 'PRI').map((comp) => {
    const allowed = c.links[p.crn]?.[comp.key];
    return `<div class="small"><b>${esc(comp.label)}</b> allowed with ${esc(p.number)}:<br>${comp.sections.map((s) =>
      `<label><input type="checkbox" data-act="linkset" data-key="${esc(c.key)}" data-primary="${p.crn}" data-comp="${comp.key}" data-crn="${s.crn}" ${!allowed || allowed.includes(s.crn) ? 'checked' : ''}> ${esc(s.number)} ${esc(s.meetings[0] ? meetingText(s.meetings[0]).split(' · ')[0] : '')}</label>`).join('')}</div>`;
  }).join('')}</div>`;
}

function onCoursesChange(e) {
  const el = e.target;
  const c = state.courses.find((x) => x.key === el.dataset.key);
  if (!c) return;
  if (el.dataset.act === 'needed') c.skip[el.dataset.comp] = !el.checked;
  if (el.dataset.act === 'include') c.excluded[el.dataset.crn] = !el.checked;
  if (el.dataset.act === 'profToggle') {
    for (const g of profGroups(c)) {
      if (g.key === el.dataset.prof) for (const s of g.sections) c.excluded[s.crn] = !el.checked;
    }
  }
  if (el.dataset.act === 'linkset') {
    const boxes = [...document.querySelectorAll('#tab-sections [data-act="linkset"]')]
      .filter((b) => b.dataset.key === c.key && b.dataset.primary === el.dataset.primary && b.dataset.comp === el.dataset.comp);
    const allowed = boxes.filter((b) => b.checked).map((b) => b.dataset.crn);
    const entry = c.links[el.dataset.primary] ||= {};
    if (allowed.length === boxes.length) delete entry[el.dataset.comp]; else entry[el.dataset.comp] = allowed;
    if (!Object.keys(entry).length) delete c.links[el.dataset.primary];
  }
  save();
  renderCourses();
}

function onCoursesClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'INPUT') return;
  const c = state.courses.find((x) => x.key === b.dataset.key);
  if (b.dataset.act === 'remove') { e.preventDefault(); return removeCourse(b.dataset.key); }
  if (b.dataset.act === 'gotoSections') return switchTab('sections');
  if (!c) return;
  if (['selAll', 'selComp'].includes(b.dataset.act)) {
    e.preventDefault(); // buttons sit inside <summary>
    const on = b.dataset.val === '1';
    for (const s of c.sections) {
      if (b.dataset.act === 'selAll' || s.comp === b.dataset.comp) c.excluded[s.crn] = !on;
    }
  } else if (b.dataset.act === 'pin') c.pins[b.dataset.comp] = b.dataset.crn;
  else if (b.dataset.act === 'unpin') delete c.pins[b.dataset.comp];
  else if (b.dataset.act === 'linkedit') c.linkEdit = c.linkEdit === b.dataset.crn ? null : b.dataset.crn;
  else return;
  save();
  renderCourses();
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
    ${slider('w.ease', 'Easier courses', 0, 10, 'Prefer lower RMP difficulty and a higher share of A grades')}
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
        <b>${esc(b.courseKey)} ${esc(b.type)}</b>${fmtTime(b.start)}–${fmtTime(b.end).replace(/ [AP]M/, '')}<br>${esc(b.bld)} ${esc(b.room)}</div>`;
    }).join('')}</div>`).join('')}</div>`;
}

// ---------- results ----------

function scheduleBlocks(s) {
  return s.sections.flatMap((x) => x.sec.meetings.flatMap((m) =>
    m.start == null ? [] : [...m.days].map((day) => ({
      day, start: m.start, end: m.end, courseKey: x.courseKey, type: x.sec.type, bld: m.building, room: m.room,
    }))));
}

function colorFor(s) {
  const keys = [...new Set(s.sections.map((x) => x.courseKey))];
  return (k) => {
    const i = state.courses.findIndex((c) => c.key === k);
    return COLORS[(i >= 0 ? i : keys.indexOf(k)) % COLORS.length];
  };
}

function summary(s) {
  const m = s.metrics;
  const days = DAYS.filter((d) => m.dayList.includes(d)).join('') + m.dayList.filter((d) => !DAYS.includes(d)).join('');
  return `${days} · ${m.credits} hr · gaps ${fmtDuration(m.gapMin)} · RMP ${m.rmp.toFixed(1)} · GPA ${m.gpa.toFixed(2)}`;
}

// idx: -1 for the current results, otherwise the saved-schedule index
function detail(s, profSource, idx = -1) {
  const m = s.metrics;
  const rows = s.sections.map((x) => {
    const src = profSource(x.courseKey);
    const profs = x.sec.instructors.map((i) => `${esc(i.last)}, ${esc(i.first)} ${profBadges({ profs: src }, i)}`).join('<br>') || 'Staff';
    const course = state.courses.find((c) => c.key === x.courseKey);
    const locked = course?.pins[x.comp] === x.sec.crn;
    return `<tr><td><b>${esc(x.courseKey)}</b><br><span class="muted">${esc(x.sec.typeName)}</span></td>
      <td>${esc(x.sec.number)}<br><span class="muted">${x.sec.crn}</span></td>
      <td>${x.sec.meetings.map((mt) => esc(meetingText(mt))).join('<br>')}</td><td>${profs}</td>
      <td>${course ? `<button class="mini ${locked ? 'on' : ''}" data-act="${locked ? 'unlockRow' : 'lockRow'}" data-key="${esc(x.courseKey)}" data-comp="${x.comp}" data-crn="${x.sec.crn}">${locked ? '🔓' : '🔒'}</button>` : ''}</td></tr>`;
  }).join('');
  const notes = [];
  if (m.rmpTotal && m.rmpKnown < m.rmpTotal) notes.push(`${m.rmpTotal - m.rmpKnown} instructor(s) have no RMP rating (counted as average).`);
  if (m.walkTight) notes.push(`${m.walkTight} tight walk(s) between buildings.`);
  if (m.softMin) notes.push(`${fmtDuration(m.softMin)} overlaps your "prefer free" times.`);
  if (s.variants > 1) notes.push(`${s.variants - 1} other combination(s) have the same times and instructors (interchangeable sections).`);
  const extra = m.diff == null ? '' : ` · difficulty ${m.diff.toFixed(1)} · A ${pct(m.aRate)} · W ${pct(m.wRate)}`;
  return `<div class="actions">
      ${idx < 0 ? '<button class="ghost" data-act="save">☆ Save</button>' : `<button class="ghost" data-act="unsave" data-i="${idx}">Remove from saved</button>`}
      <button class="ghost" data-act="ics" data-i="${idx}">Export .ics</button>
      <button class="ghost" data-act="crns" data-i="${idx}">Copy CRNs</button>
      <button class="ghost" data-act="share" data-i="${idx}">Share link</button>
      <button class="ghost" data-act="swaps" data-i="${idx}">Swaps &amp; backups</button>
      <button class="ghost" data-act="map" data-i="${idx}">Map</button>
      <span class="muted small">${summary(s)}${extra}</span></div>
    ${notes.length ? `<div class="notice small">${notes.map(esc).join('<br>')}</div>` : ''}
    <div id="swaps-${idx}"></div><div id="map-${idx}"></div>
    ${calendar(scheduleBlocks(s), colorFor(s))}
    <table class="sched"><thead><tr><th>Course</th><th>Sec / CRN</th><th>Meets</th><th>Instructor</th><th title="Lock this section and regenerate"></th></tr></thead><tbody>${rows}</tbody></table>${transitionsHtml(s)}`;
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
    <div class="t"><span>#${i + 1}${s.label ? ` · ${esc(s.label)}` : ''}</span><span class="muted small">${i === 0 ? 'best' : `${(s.score - results.schedules[0].score).toFixed(1)} vs #1`}</span></div>
    <div class="small muted">${summary(s)}</div></button>`).join('');
  el.innerHTML = `${results.truncated ? '<div class="notice small">This is a big search, so it used a guided search (best sections first, then improving the best results). It can miss unusual combinations; locking sections or excluding some narrows it.</div>' : ''}
    <div class="results"><div class="rlist">${list}</div>
    <div>${detail(results.schedules[selected], (k) => state.courses.find((c) => c.key === k)?.profs)}</div></div>`;
}

function scheduleAt(i) {
  return i >= 0 ? state.saved[i] : results?.schedules[selected];
}

// ---------- swaps & backups ----------

function showSwaps(i) {
  const box = $(`#swaps-${i}`);
  if (box.innerHTML) { box.innerHTML = ''; return; }
  const s = scheduleAt(i);
  let alts = null;
  try { alts = alternatives(readyCourses(), s, state.prefs, state.grid, geo); } catch {}
  if (!alts) {
    box.innerHTML = '<div class="notice small">Swaps need these courses loaded and their sections still allowed (not excluded or blocked by your breaks).</div>';
    return;
  }
  lastSwaps = { i, alts };
  box.innerHTML = `<div class="panelbox"><b>If a section fills</b><div class="small muted">Best single replacements, with the score change. Linked sections that must change too are noted.</div>
    ${alts.map((a, ai) => `<div style="margin-top:8px"><b>${esc(a.courseKey)}</b> ${esc(a.label)} <span class="muted">(now CRN ${a.current})</span>
      ${a.options.length ? a.options.map((o, oi) => `<div class="swaprow"><span class="crn" style="font-size:14px">${o.crn}</span>
        <span class="delta ${o.delta >= 0 ? 'up' : 'down'}">${o.delta >= 0 ? '+' : ''}${o.delta.toFixed(1)}</span>
        <span class="muted">${esc(summary(o.result))}</span>${o.changed.length ? `<span class="eq">also changes ${o.changed.join(', ')}</span>` : ''}
        <button class="mini" data-act="applySwap" data-ai="${ai}" data-oi="${oi}">Use this</button></div>`).join('')
        : '<div class="muted small">No valid alternative.</div>'}</div>`).join('')}</div>`;
}

function applySwap(ai, oi) {
  if (!lastSwaps) return;
  const o = lastSwaps.alts[ai].options[oi];
  const { i } = lastSwaps;
  if (i >= 0) {
    state.saved[i] = { ...o.result, label: state.saved[i].label, profsSnapshot: state.saved[i].profsSnapshot };
    save();
    renderSaved();
  } else {
    o.result.label = 'swap';
    results.schedules.splice(selected + 1, 0, o.result);
    selected += 1;
    renderResults();
  }
  toast('Swapped');
}

// ---------- map ----------

let leafletPromise = null;
function loadLeaflet() {
  leafletPromise ||= new Promise((resolve, reject) => {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css' });
    const js = Object.assign(document.createElement('script'), { src: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js' });
    js.onload = () => resolve(window.L);
    js.onerror = () => { leafletPromise = null; reject(new Error('Could not load the map library')); };
    document.head.append(css, js);
  });
  return leafletPromise;
}

const maps = new Map();

async function showMap(i, day) {
  const box = $(`#map-${i}`);
  if (!day && box.innerHTML) { maps.get(box)?.remove(); maps.delete(box); box.innerHTML = ''; return; }
  const s = scheduleAt(i);
  const blocks = scheduleBlocks(s);
  const days = [...new Set(blocks.map((b) => b.day))];
  if (!days.length) { box.innerHTML = '<div class="notice small">No in-person meetings to map.</div>'; return; }
  day ||= days.sort((a, b) => 'MTWRFSU'.indexOf(a) - 'MTWRFSU'.indexOf(b))[0];
  let L;
  try { L = await loadLeaflet(); } catch (err) { box.innerHTML = `<div class="notice small">${esc(err.message)}</div>`; return; }
  maps.get(box)?.remove();
  const ordered = [...days].sort((a, b) => 'MTWRFSU'.indexOf(a) - 'MTWRFSU'.indexOf(b));
  box.innerHTML = `<div class="actions">${ordered.map((d) => `<button class="ghost ${d === day ? 'on' : ''}" data-act="mapday" data-i="${i}" data-day="${d}">${DAY_NAMES[d]}</button>`).join('')}
    <span class="muted small">Walking estimates use straight-line distance × 1.3 at ~4.8 km/h.</span></div><div class="mapview"></div>`;
  const map = L.map(box.querySelector('.mapview'));
  maps.set(box, map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  const dayBlocks = blocks.filter((b) => b.day === day).sort((a, b) => a.start - b.start);
  const pts = [];
  const missing = [];
  dayBlocks.forEach((b, n) => {
    const g = geo[b.bld];
    if (!g) { if (b.bld) missing.push(b.bld); return; }
    const p = [g.lat, g.lon];
    pts.push({ p, b });
    L.circleMarker(p, { radius: 9, color: '#13294b', fillColor: '#e84a27', fillOpacity: 0.9, weight: 2 }).addTo(map)
      .bindTooltip(`${n + 1}. ${fmtTime(b.start)} ${b.courseKey} · ${b.bld}`, { permanent: true, direction: 'top', offset: [0, -8] });
  });
  for (let n = 1; n < pts.length; n++) {
    const a = pts[n - 1];
    const b = pts[n];
    const gap = b.b.start - a.b.end;
    const walk = walkMinutes(a.b.bld, b.b.bld, geo);
    L.polyline([a.p, b.p], { color: gap < walk ? '#c0392b' : '#1f8a4c', weight: 4 }).addTo(map)
      .bindTooltip(`${walk} min walk, ${gap} min between classes`, { sticky: true });
  }
  if (pts.length) map.fitBounds(pts.map((x) => x.p), { padding: [40, 40], maxZoom: 17 });
  else map.setView([40.1097, -88.2272], 15);
  if (missing.length) box.insertAdjacentHTML('beforeend', `<div class="muted small">No location yet for: ${esc([...new Set(missing)].join(', '))}</div>`);
}

// ---------- saved & compare ----------

const CMP_ROWS = [
  ['Credits', (m) => m.credits, null, (v) => v],
  ['Days on campus', (m) => m.days, 'min', (v) => v],
  ['Idle time between classes', (m) => m.gapMin, 'min', fmtDuration],
  ['Earliest class', (m) => m.earliest, null, fmtTime],
  ['Latest class ends', (m) => m.latest, null, fmtTime],
  ['Avg RMP rating', (m) => m.rmp, 'max', (v) => v.toFixed(2)],
  ['Avg GPA', (m) => m.gpa, 'max', (v) => v.toFixed(2)],
  ['Share of A grades', (m) => m.aRate, 'max', pct],
  ['RMP difficulty', (m) => m.diff, 'min', (v) => v.toFixed(1)],
  ['Withdraw rate', (m) => m.wRate, 'min', pct],
  ['Tight walks', (m) => m.walkTight, 'min', (v) => v],
];

function compareHtml() {
  const list = compareSel.map((i) => state.saved[i]).filter(Boolean);
  if (list.length < 2) return '<p class="muted small">Tick 2–3 saved schedules to compare them side by side.</p>';
  const head = list.map((s) => `<th>${esc(s.label)}</th>`).join('');
  const body = CMP_ROWS.map(([label, get, dir, fmt]) => {
    const vals = list.map((s) => get(s.metrics));
    const known = vals.filter((v) => v != null);
    const best = dir && known.length > 1 ? (dir === 'max' ? Math.max(...known) : Math.min(...known)) : null;
    return `<tr><th>${label}</th>${vals.map((v) => `<td class="${best != null && v === best ? 'best' : ''}">${v == null ? '–' : esc(fmt(v))}</td>`).join('')}</tr>`;
  }).join('');
  const crns = `<tr><th>CRNs</th>${list.map((s) => `<td>${s.sections.map((x) => x.sec.crn).join(', ')}</td>`).join('')}</tr>`;
  return `<div class="compare"><table><thead><tr><th></th>${head}</tr></thead><tbody>${body}${crns}</tbody></table>
    <div class="cals">${list.map((s) => `<div><b>${esc(s.label)}</b>${calendar(scheduleBlocks(s), colorFor(s))}</div>`).join('')}</div></div>`;
}

function renderSaved() {
  const el = $('#tab-saved');
  $('#savedCount').textContent = state.saved.length ? `(${state.saved.length})` : '';
  if (!state.saved.length) {
    el.innerHTML = '<p class="muted">Nothing saved yet. Use ☆ Save on a schedule.</p>';
    return;
  }
  for (let k = compareSel.length - 1; k >= 0; k--) if (!state.saved[compareSel[k]]) compareSel.splice(k, 1);
  el.innerHTML = `<div class="panelbox"><b>Compare</b>${compareHtml()}</div>` + state.saved.map((s, i) =>
    `<h3 style="margin:18px 0 0"><label><input type="checkbox" data-act="cmp" data-i="${i}" ${compareSel.includes(i) ? 'checked' : ''}> ${esc(s.label)}</label></h3>${detail(s, (k) => s.profsSnapshot?.[k], i)}`).join('<hr>');
}

// ---------- browse courses ----------

const browse = { data: null, error: null, loading: false, f: { q: '', subject: '', gened: '', level: '', credits: '' } };

async function loadIndex() {
  if (browse.data?.term === term() || browse.loading) return;
  browse.loading = true;
  browse.error = null;
  browse.data = null;
  try {
    const res = await fetch(`data/index_${state.year}_${state.season}.json`);
    if (!res.ok) throw new Error(`No course index for ${state.season} ${state.year} yet. Build one with: npm run build-index -- ${term()}`);
    browse.data = await res.json();
  } catch (err) {
    browse.error = err.message;
  }
  browse.loading = false;
}

function renderBrowse() {
  const el = $('#tab-browse');
  if (browse.loading) { el.innerHTML = '<p class="muted">Loading course index…</p>'; return; }
  if (browse.error) { el.innerHTML = `<div class="notice">${esc(browse.error)}</div>`; return; }
  if (!browse.data) { el.innerHTML = ''; return; }
  const d = browse.data;
  const genEds = [...new Map(d.courses.flatMap((c) => c.genEd).map((g) => [g.code, g.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const credits = [...new Set(d.courses.map((c) => c.credits))].filter(Boolean).sort((a, b) => a - b);
  const f = browse.f;
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  el.innerHTML = `<div class="browse-filters">
      <input id="bq" placeholder="Search title or number" value="${esc(f.q)}">
      <select id="bsubject"><option value="">All subjects</option>${d.subjects.map((s) => opt(s.id, `${s.id} – ${s.label}`, f.subject)).join('')}</select>
      <select id="bgened"><option value="">Any gen-ed</option>${genEds.map(([code, name]) => opt(code, name, f.gened)).join('')}</select>
      <select id="blevel"><option value="">Any level</option>${[1, 2, 3, 4, 5].map((n) => opt(n, `${n}00-level`, f.level)).join('')}</select>
      <select id="bcredits"><option value="">Any credits</option>${credits.map((c) => opt(c, `${c} hr`, f.credits)).join('')}</select>
    </div><div id="blist"></div>
    <p class="muted small">Index built ${esc(d.built)}. Only courses with scheduled sections are listed.</p>`;
  renderBrowseList();
}

function renderBrowseList() {
  const d = browse.data;
  const f = browse.f;
  const q = f.q.trim().toLowerCase();
  const taken = takenSet();
  const rows = d.courses.filter((c) => c.sectionCount > 0
    && (!f.subject || c.subject === f.subject)
    && (!f.gened || c.genEd.some((g) => g.code === f.gened))
    && (!f.level || String(c.number)[0] === String(f.level))
    && (!f.credits || String(c.credits) === String(f.credits))
    && (!q || `${c.subject} ${c.number} ${c.title}`.toLowerCase().includes(q)));
  const shown = rows.slice(0, 120);
  $('#blist').innerHTML = `<div class="muted small">${rows.length} course${rows.length === 1 ? '' : 's'}${rows.length > shown.length ? ` (showing ${shown.length})` : ''}</div>`
    + shown.map((c) => {
      const added = state.courses.some((x) => x.key === c.key);
      return `<div class="brow"><div><b>${esc(c.key)}</b> ${esc(c.title)} <span class="muted small">${c.credits} hr · ${c.sectionCount} sections</span>
        ${c.genEd.map((g) => `<span class="tag">${esc(g.name)}</span>`).join('')}</div>
        <button class="ghost" data-act="browseAdd" data-subject="${esc(c.subject)}" data-number="${esc(c.number)}" ${added ? 'disabled' : ''}>${added ? 'Added' : 'Add'}</button>
        <div class="desc">${esc(c.description)}${c.description.length >= 240 ? '…' : ''}</div>
        ${c.prereq ? prereqHtml(c.prereq).replace('class="prereq"', 'class="prereq" style="grid-column:1/-1"') : ''}</div>`;
    }).join('');
  void taken;
}

function onBrowseInput(e) {
  const map = { bq: 'q', bsubject: 'subject', bgened: 'gened', blevel: 'level', bcredits: 'credits' };
  if (!map[e.target.id]) return;
  browse.f[map[e.target.id]] = e.target.value;
  renderBrowseList();
}

// ---------- registration day ----------

function regPlan() {
  const p = state.reg.plan;
  return p === 'cur' ? results?.schedules[selected] : state.saved[Number(p)];
}

function renderRegister() {
  const el = $('#tab-register');
  const plan = regPlan();
  const opts = [];
  if (results?.schedules[selected]) opts.push(['cur', `Current schedule (#${selected + 1})`]);
  state.saved.forEach((s, i) => opts.push([String(i), s.label]));
  if (!opts.length) {
    el.innerHTML = '<p class="muted">Generate or save a schedule first, then use this page on registration day.</p>';
    return;
  }
  if (!plan) state.reg.plan = opts[0][0];
  const s = regPlan();
  let alts = null;
  try { alts = alternatives(readyCourses(), s, state.prefs, state.grid, geo, 2); } catch {}
  const rows = s.sections.map((x) => {
    const a = alts?.find((y) => y.courseKey === x.courseKey && y.comp === x.comp);
    const done = !!state.reg.done[x.sec.crn];
    return `<div class="regrow ${done ? 'done' : ''}">
      <input type="checkbox" data-act="regdone" data-crn="${x.sec.crn}" ${done ? 'checked' : ''} aria-label="Registered">
      <div><b>${esc(x.courseKey)}</b> ${esc(x.sec.typeName)} <span class="muted">${esc(x.sec.number)}</span><br>
        <span class="muted small">${x.sec.meetings.map((m) => esc(meetingText(m))).join(' / ')}</span>
        ${a?.options.length ? `<div class="small"><span class="muted">Backup if full:</span> ${a.options.map((o) => `<b>${o.crn}</b> <span class="delta ${o.delta >= 0 ? 'up' : 'down'}">(${o.delta >= 0 ? '+' : ''}${o.delta.toFixed(1)})</span>`).join(', ')}</div>` : ''}</div>
      <span class="crn">${x.sec.crn}</span>
      <button class="ghost" data-act="copycrn" data-crn="${x.sec.crn}">Copy</button></div>`;
  }).join('');
  el.innerHTML = `<div class="actions">
      <label>Plan <select id="regPlan">${opts.map(([v, l]) => `<option value="${v}" ${state.reg.plan === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label>Registration opens <input type="datetime-local" id="regTime" value="${esc(state.reg.time)}"></label>
      <button class="ghost" data-act="copyall">Copy all CRNs</button>
      <button class="ghost" onclick="window.print()">Print</button>
      <a class="ghost" style="padding:4px 10px;border:1px solid var(--line);border-radius:6px;text-decoration:none" href="https://my.illinois.edu/" target="_blank" rel="noopener">Open my.illinois.edu</a></div>
    <div class="countdown" id="countdown"></div>
    <div>${rows}</div>
    <p class="muted small">Tick each class as you register. Backups are the best single swaps if a section is full (same scoring as your preferences).</p>`;
  tickCountdown();
}

function tickCountdown() {
  const el = $('#countdown');
  if (!el) return;
  if (!state.reg.time) { el.textContent = ''; return; }
  const ms = new Date(state.reg.time).getTime() - Date.now();
  if (Number.isNaN(ms)) { el.textContent = ''; return; }
  if (ms <= 0) { el.textContent = 'Registration is open'; return; }
  const d = Math.floor(ms / 864e5);
  const h = Math.floor(ms / 36e5) % 24;
  const m = Math.floor(ms / 6e4) % 60;
  const sec = Math.floor(ms / 1000) % 60;
  el.textContent = `Opens in ${d ? `${d}d ` : ''}${h}h ${m}m ${sec}s`;
}
setInterval(tickCountdown, 1000);

// ---------- actions ----------

async function runGenerate() {
  if (state.courses.some((c) => c.loading)) return toast('Still loading course data…');
  const ready = readyCourses();
  const broken = state.courses.filter((c) => c.error);
  if (broken.length) toast(`Skipping ${broken.map((c) => c.key).join(', ')} (not available this term)`);
  switchTab('results');
  $('#tab-results').innerHTML = '<p class="muted">Searching…</p>';
  results = await generateAsync(ready);
  selected = 0;
  renderResults();
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
      compareSel.length = 0;
      save(); renderSaved(); toast('Saved');
      break;
    }
    case 'unsave': state.saved.splice(i, 1); compareSel.length = 0; save(); renderSaved(); break;
    case 'ics': download('schedule.ics', toICS(scheduleAt(i)), 'text/calendar'); break;
    case 'crns': {
      const text = scheduleAt(i).sections.map((x) => x.sec.crn).join(', ');
      copy(text, `Copied CRNs: ${text}`);
      break;
    }
    case 'share': copy(shareLink(scheduleAt(i)), 'Share link copied'); break;
    case 'swaps': showSwaps(i); break;
    case 'applySwap': applySwap(Number(b.dataset.ai), Number(b.dataset.oi)); break;
    case 'map': showMap(i); break;
    case 'mapday': showMap(i, b.dataset.day); break;
    case 'lockRow': case 'unlockRow': {
      const c = state.courses.find((x) => x.key === b.dataset.key);
      if (!c) break;
      if (b.dataset.act === 'lockRow') c.pins[b.dataset.comp] = b.dataset.crn; else delete c.pins[b.dataset.comp];
      save(); renderCourses();
      if (b.dataset.act === 'lockRow') { toast(`Locked ${b.dataset.key}; regenerating`); runGenerate(); } else renderResults();
      break;
    }
    case 'browseAdd': addCourse(b.dataset.subject, b.dataset.number).then(renderBrowseList); break;
    case 'regdone': break;
    case 'copycrn': copy(b.dataset.crn, `Copied ${b.dataset.crn}`); break;
    case 'copyall': copy(regPlan().sections.map((x) => x.sec.crn).join(', '), 'Copied all CRNs'); break;
  }
}

function onContentChange(e) {
  const el = e.target;
  if (el.dataset.act === 'cmp') {
    const i = Number(el.dataset.i);
    const at = compareSel.indexOf(i);
    if (el.checked && at < 0) { compareSel.push(i); if (compareSel.length > 3) compareSel.shift(); }
    if (!el.checked && at >= 0) compareSel.splice(at, 1);
    renderSaved();
  } else if (el.dataset.act === 'regdone') {
    state.reg.done[el.dataset.crn] = el.checked;
    save();
    renderRegister();
  } else if (el.id === 'regPlan') {
    state.reg.plan = el.value; save(); renderRegister();
  } else if (el.id === 'regTime') {
    state.reg.time = el.value; save(); tickCountdown();
  }
}

function switchTab(name) {
  for (const t of document.querySelectorAll('.tabs button')) t.classList.toggle('on', t.dataset.tab === name);
  for (const n of ['breaks', 'sections', 'results', 'saved', 'browse', 'register']) $(`#tab-${n}`).hidden = n !== name;
  if (name === 'browse') { renderBrowse(); loadIndex().then(renderBrowse); }
  if (name === 'register') renderRegister();
  if (name === 'saved') renderSaved();
}

// Walking times use real building locations, geocoded by the server in the background.
async function refreshGeo(attempt = 0) {
  const names = [...new Set(state.courses.flatMap((c) => (c.sections || []).flatMap((s) => s.meetings.map((m) => m.building))))]
    .filter(Boolean);
  if (!names.length) return;
  try {
    const r = await api(`/api/geo?${names.map((n) => `b=${encodeURIComponent(n)}`).join('&')}`);
    for (const [n, v] of Object.entries(r.results)) if (v) geo[n] = v;
    if (r.pending && attempt < 60) setTimeout(() => refreshGeo(attempt + 1), 1500);
  } catch {}
}

async function loadTerm() {
  $('#season').value = state.season;
  $('#year').value = state.year;
  subjects = await api(`/api/subjects?term=${term()}`).catch(() => []);
  await Promise.all(state.courses.map(fetchCourse));
}

async function finishShare() {
  const p = pendingShare;
  pendingShare = null;
  if (!p?.s?.length) return;
  const r = buildSchedule(readyCourses(), p.s, state.prefs, state.grid, geo);
  if (!r) return toast('Some shared sections are no longer available');
  r.label = 'shared';
  results = { schedules: [r], problems: [], truncated: false };
  selected = 0;
  renderResults();
  switchTab('results');
}

// ---------- init ----------

load();
readShare();
renderPrefs();
renderBreaks();
renderResults();
renderSaved();
renderCourses();
$('#taken').value = state.taken;

for (const id of ['#courses', '#tab-sections']) {
  $(id).addEventListener('click', onCoursesClick);
  $(id).addEventListener('change', onCoursesChange);
}
$('#tab-sections').addEventListener('toggle', (e) => {
  const c = state.courses.find((x) => x.key === e.target.dataset?.key);
  if (c && e.target.tagName === 'DETAILS') c.openSections = e.target.open;
}, true);
$('#taken').addEventListener('input', (e) => { state.taken = e.target.value; save(); renderCourses(); });

$('#prefs').addEventListener('input', onPrefInput);
$('#prefs').addEventListener('change', onPrefInput);
$('#generate').addEventListener('click', runGenerate);
document.querySelector('.tabs').addEventListener('click', (e) => {
  if (e.target.dataset.tab) switchTab(e.target.dataset.tab);
});
for (const id of ['#tab-breaks', '#tab-results', '#tab-saved', '#tab-browse', '#tab-register']) {
  $(id).addEventListener('click', onContentClick);
  $(id).addEventListener('change', onContentChange);
}
$('#tab-browse').addEventListener('input', onBrowseInput);

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

// Pasting a share link into an already-open tab only changes the hash; reload so it is picked up.
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#share=')) location.reload(); });

$('#shareSetup').addEventListener('click', () => copy(shareLink(null), 'Link to your setup copied'));
$('#backup').addEventListener('click', () => download('illini-scheduler-backup.json', JSON.stringify(snapshot(), null, 1), 'application/json'));
$('#restore').addEventListener('click', () => $('#restoreFile').click());
$('#restoreFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    applyState(JSON.parse(await file.text()));
    save();
    renderPrefs(); renderBreaks(); renderSaved(); renderCourses();
    $('#taken').value = state.taken;
    await loadTerm();
    toast('Backup restored');
  } catch { toast('That file is not a valid backup'); }
});

showShareBanner();
loadTerm().then(() => refreshGeo());

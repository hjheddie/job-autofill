const YESNO = ['', 'Yes', 'No'];
const EEO = ['', 'Decline', 'Male', 'Female', 'Non-binary'];
const RACES = [
  '', 'Decline', 'Hispanic or Latino', 'White', 'Black or African American', 'Asian',
  'Native Hawaiian or Other Pacific Islander', 'American Indian or Alaska Native', 'Two or More Races',
];

const SECTIONS = [
  ['Contact', [
    ['firstName', 'First name'], ['lastName', 'Last name'], ['email', 'Email'], ['phone', 'Phone'],
    ['address', 'Street address'], ['city', 'City'], ['state', 'State / province', 'states'],
    ['zip', 'ZIP / postal code'], ['country', 'Country', 'countries'],
  ]],
  ['Links', [
    ['linkedin', 'LinkedIn URL'], ['github', 'GitHub URL'], ['portfolio', 'Website / portfolio'],
  ]],
  ['Other', [
    ['salary', 'Salary expectation'],
  ]],
  ['Work authorization', [
    ['workAuth', 'Legally authorized to work?', YESNO],
    ['sponsorship', 'Require visa sponsorship?', YESNO],
  ]],
  ['Voluntary self-identification (blank or "Decline" = decline to answer)', [
    ['gender', 'Gender', EEO],
    ['race', 'Race', RACES],
    ['hispanic', 'Hispanic or Latino?', ['', 'Decline', 'Yes', 'No']],
    ['veteran', 'Veteran status', ['', 'Decline', 'Yes', 'No']],
    ['disability', 'Disability status', ['', 'Decline', 'Yes', 'No']],
  ]],
];

const form = document.getElementById('f');
const status = document.getElementById('status');
let resume = null;

const { STATES, COUNTRIES } = window.JA_DATA;

// Type-to-search lists: <input list=...> shows a filtered dropdown as you type.
function addDatalist(id, values) {
  const dl = document.createElement('datalist');
  dl.id = id;
  values.forEach((v) => dl.append(new Option(v)));
  document.body.append(dl);
}
addDatalist('states', Object.values(STATES));
addDatalist('countries', COUNTRIES);

function field([key, label, opts]) {
  const l = document.createElement('label');
  l.textContent = label;
  const searchable = typeof opts === 'string';
  const el = document.createElement(opts && !searchable ? 'select' : 'input');
  el.name = key;
  if (searchable) { el.setAttribute('list', opts); el.autocomplete = 'off'; el.placeholder = 'Start typing…'; }
  else if (opts) opts.forEach((o) => el.append(new Option(o || '—', o)));
  l.append(el);
  return l;
}

// "IL" / "il" -> "Illinois" so the stored value is always the full name.
function canonState(v) {
  const up = v.toUpperCase();
  if (STATES[up]) return STATES[up];
  return Object.values(STATES).find((n) => n.toLowerCase() === v.toLowerCase()) || v;
}
function canonCountry(v) {
  const aliases = { usa: 'United States', us: 'United States', 'united states of america': 'United States', uk: 'United Kingdom' };
  return aliases[v.toLowerCase()] || COUNTRIES.find((c) => c.toLowerCase() === v.toLowerCase()) || v;
}

for (const [title, fields] of SECTIONS) {
  const h = document.createElement('h2'); h.textContent = title; form.append(h);
  const g = document.createElement('div'); g.className = 'grid';
  fields.forEach((f) => g.append(field(f)));
  form.append(g);
}

// ---- Repeatable blocks: work experience and education ----
const MONTHS = ['', ...Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'))];
const DEGREES = ['', 'High School', "Associate's", "Bachelor's", "Master's", 'Doctorate (PhD)'];
const LISTS = {
  workExperience: {
    title: 'Work experience (most recent first)', add: 'Add job',
    fields: [
      ['title', 'Job title'], ['company', 'Company'], ['location', 'Location'],
      ['current', 'I currently work here', 'checkbox'],
      ['fromMonth', 'Start month', MONTHS], ['fromYear', 'Start year'],
      ['toMonth', 'End month', MONTHS], ['toYear', 'End year'],
      ['description', 'Role description', 'textarea'],
    ],
  },
  education: {
    title: 'Education', add: 'Add school',
    fields: [
      ['school', 'School or university'], ['degree', 'Degree', DEGREES], ['field', 'Field of study'],
      ['gpa', 'GPA'],
      ['fromMonth', 'Start month', MONTHS], ['fromYear', 'Start year'],
      ['toMonth', 'Graduation month (actual or expected)', MONTHS], ['toYear', 'Graduation year (actual or expected)'],
    ],
  },
};
const lists = { workExperience: [], education: [] };

function renderList(name) {
  const cfg = LISTS[name];
  const box = document.getElementById('list-' + name);
  box.textContent = '';
  lists[name].forEach((entry, idx) => {
    const fs = document.createElement('fieldset');
    const lg = document.createElement('legend');
    lg.textContent = `${cfg.title.split(' (')[0]} ${idx + 1}`;
    fs.append(lg);
    const g = document.createElement('div'); g.className = 'grid';
    for (const [key, label, kind] of cfg.fields) {
      const l = document.createElement('label'); l.textContent = label;
      let el;
      if (Array.isArray(kind)) { el = document.createElement('select'); kind.forEach((o) => el.append(new Option(o || '—', o))); }
      else if (kind === 'textarea') { el = document.createElement('textarea'); el.rows = 3; l.style.gridColumn = '1 / -1'; }
      else { el = document.createElement('input'); if (kind === 'checkbox') { el.type = 'checkbox'; el.style.width = 'auto'; } }
      if (kind === 'checkbox') el.checked = !!entry[key]; else el.value = entry[key] || '';
      el.addEventListener('input', () => { entry[key] = kind === 'checkbox' ? el.checked : el.value.trim(); });
      l.append(el); g.append(l);
    }
    fs.append(g);
    const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = 'Remove';
    rm.className = 'secondary';
    rm.onclick = () => { lists[name].splice(idx, 1); renderList(name); };
    fs.append(rm);
    box.append(fs);
  });
}

for (const name of Object.keys(LISTS)) {
  const h = document.createElement('h2'); h.textContent = LISTS[name].title; form.append(h);
  const box = document.createElement('div'); box.id = 'list-' + name; form.append(box);
  const add = document.createElement('button'); add.type = 'button'; add.className = 'secondary';
  add.textContent = '+ ' + LISTS[name].add;
  add.onclick = () => { lists[name].push({}); renderList(name); };
  form.append(add);
}

form.insertAdjacentHTML('beforeend', `
  <h2>Resume</h2>
  <label>PDF / DOC (max 5 MB) <input type="file" id="resume" accept=".pdf,.doc,.docx"></label>
  <div id="resumeRow" hidden>
    <span id="resumeName"></span>
    <button type="button" id="resumeView" class="secondary">View</button>
    <button type="button" id="resumeRemove" class="secondary">Remove</button>
  </div>
  <small id="resumeNote"></small>
  <h2>Saved answers</h2>
  <label>One per line: <code>question text =&gt; answer</code>. Matches when the form's label contains the question text.
    <textarea id="qa" rows="6" placeholder="how did you hear about us => LinkedIn&#10;willing to relocate => Yes"></textarea>
  </label>`);

const sizeLabel = (b64) => {
  const kb = Math.round((b64.length * 3) / 4 / 1024);
  return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB';
};

function updateResumeUI(note = '') {
  document.getElementById('resumeRow').hidden = !resume;
  document.getElementById('resumeName').textContent = resume ? `${resume.name} (${sizeLabel(resume.data)})` : '';
  document.getElementById('resumeNote').textContent = resume ? note : 'No resume uploaded for this profile.';
}

function resumeBlob() {
  const bin = atob(resume.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: resume.type || 'application/pdf' });
}

document.getElementById('resumeView').onclick = () => {
  if (!resume) return;
  const url = URL.createObjectURL(resumeBlob());
  // PDFs open in a tab; DOC/DOCX are downloaded by the browser.
  if (!window.open(url, '_blank')) {
    const a = Object.assign(document.createElement('a'), { href: url, download: resume.name });
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

document.getElementById('resumeRemove').onclick = () => {
  if (!resume || !confirm(`Remove "${resume.name}" from this profile?`)) return;
  resume = null;
  document.getElementById('resume').value = '';
  dirty = true;
  updateResumeUI();
  document.getElementById('resumeNote').textContent = 'Removed — click Save to apply.';
};

document.addEventListener('change', (e) => {
  if (e.target.id !== 'resume') return;
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { status.textContent = 'Resume too large'; return; }
  const r = new FileReader();
  r.onload = () => {
    resume = { name: file.name, type: file.type, data: r.result.split(',')[1] };
    dirty = true;
    updateResumeUI('Not saved yet — click Save.');
  };
  r.readAsDataURL(file);
});

// ---- Profiles ----
const sel = document.getElementById('profileSel');
let store = null; // { profiles, activeProfileId }
let dirty = false;
form.addEventListener('input', () => { dirty = true; });

function collectForm() {
  const profile = {};
  new FormData(form).forEach((v, k) => { if (k !== 'resume') profile[k] = String(v).trim(); });
  if (profile.state) profile.state = canonState(profile.state);
  if (profile.country) profile.country = canonCountry(profile.country);
  for (const name of Object.keys(lists)) {
    profile[name] = lists[name].filter((e) => Object.values(e).some((v) => v && v !== false));
  }
  profile.customQA = document.getElementById('qa').value.split('\n')
    .map((line) => line.split('=>'))
    .filter((p) => p.length >= 2 && p[0].trim() && p[1].trim())
    .map((p) => ({ q: p[0].trim(), a: p.slice(1).join('=>').trim() }));
  profile.resume = resume || null;
  return profile;
}

function populateForm(profile) {
  profile = profile || {};
  for (const el of form.elements) if (el.name) el.value = profile[el.name] != null ? profile[el.name] : '';
  for (const name of Object.keys(lists)) {
    lists[name] = (profile[name] || []).map((e) => ({ ...e }));
    renderList(name);
  }
  document.getElementById('qa').value = (profile.customQA || []).map((x) => `${x.q} => ${x.a}`).join('\n');
  resume = profile.resume || null;
  document.getElementById('resume').value = '';
  updateResumeUI('Saved.');
  dirty = false;
}

function renderBar() {
  sel.textContent = '';
  for (const [id, p] of Object.entries(store.profiles)) sel.append(new Option(p.name, id, false, id === store.activeProfileId));
  sel.value = store.activeProfileId;
  document.getElementById('pDel').disabled = Object.keys(store.profiles).length < 2;
}

const persist = () => JA_PROFILES.save(store.profiles, store.activeProfileId);
const current = () => store.profiles[store.activeProfileId];
const confirmDiscard = () => !dirty || confirm('You have unsaved changes in this profile. Discard them?');

function flash(msg) {
  status.textContent = msg;
  setTimeout(() => (status.textContent = ''), 2000);
}

async function switchTo(id) {
  store.activeProfileId = id;
  await persist();
  renderBar();
  populateForm(current().data);
}

sel.onchange = async () => {
  if (!confirmDiscard()) { sel.value = store.activeProfileId; return; }
  await switchTo(sel.value);
};

document.getElementById('pNew').onclick = async () => {
  if (!confirmDiscard()) return;
  const name = (prompt('Name for the new profile:', 'New profile') || '').trim();
  if (!name) return;
  const id = JA_PROFILES.uid();
  store.profiles[id] = { name, data: {} };
  await switchTo(id);
};

document.getElementById('pDup').onclick = async () => {
  const name = (prompt('Name for the copy:', current().name + ' copy') || '').trim();
  if (!name) return;
  const id = JA_PROFILES.uid();
  store.profiles[id] = { name, data: JSON.parse(JSON.stringify(collectForm())) };
  await persist();
  await switchTo(id);
  flash('Copied (unsaved edits included)');
};

document.getElementById('pRen').onclick = async () => {
  const name = (prompt('Rename profile:', current().name) || '').trim();
  if (!name) return;
  current().name = name;
  await persist();
  renderBar();
};

document.getElementById('pDel').onclick = async () => {
  if (Object.keys(store.profiles).length < 2) return;
  if (!confirm(`Delete profile "${current().name}"? This can't be undone.`)) return;
  delete store.profiles[store.activeProfileId];
  await switchTo(Object.keys(store.profiles)[0]);
};

document.getElementById('save').onclick = async (e) => {
  e.preventDefault();
  const data = collectForm();
  current().data = data;
  await persist();
  populateForm(data); // re-show normalized values (full state name etc.)
  flash('Saved');
};

(async () => {
  store = await JA_PROFILES.load();
  renderBar();
  populateForm(current().data);
})();

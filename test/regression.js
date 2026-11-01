// Regression tests for content.js. Run: npm install && npm test
// Each case loads a small page in jsdom, runs the extension's fill logic with a sample profile and checks the result.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`);
}

// jsdom has no layout: treat an element as hidden when it or an ancestor is hidden / display:none.
function loadPage(html, profile, { skipProfilesJs = true } = {}) {
  const w = new JSDOM(html, { runScripts: 'dangerously' }).window;
  w.chrome = {};
  w.HTMLElement.prototype.getClientRects = function () {
    for (let n = this; n; n = n.parentElement) if (n.hidden || (n.style && n.style.display === 'none')) return [];
    return [1];
  };
  w.eval(read('data.js'));
  w.eval(read('content.js'));
  w.JA_PROFILES = { active: async () => profile };
  return w;
}
const val = (d, id) => {
  const e = d.getElementById(id);
  if (e.tagName === 'BUTTON') return e.textContent;
  return e.tagName === 'SELECT' ? e.options[e.selectedIndex].text : e.value;
};
const fromFixture = (file, profile) => loadPage(read(`test/${file}`), profile);

// A custom combobox whose list shows only its first page; typing filters (startsWith) after a delay.
// Items are plain divs without roles, reused for every box (like SuccessFactors' paginated select).
function paginated(w, lists, { firstPage = 3, onClick } = {}) {
  const d = w.document;
  const pop = d.createElement('div');
  pop.hidden = true;
  d.body.append(pop);
  let owner = null;
  for (let i = 0; i < 10; i++) {
    const row = d.createElement('div');
    row.innerHTML = '<span></span>';
    row.addEventListener('click', () => { const t = row.firstChild.textContent; owner.value = onClick ? onClick(t) : t; pop.hidden = true; });
    pop.append(row);
  }
  const render = (inp, items) => {
    [...pop.children].forEach((row, i) => { row.style.display = i < items.length ? '' : 'none'; row.firstChild.textContent = items[i] || ''; });
    pop.hidden = !items.length;
    owner = inp;
  };
  d.querySelectorAll('input[data-list]').forEach((inp) => {
    const all = lists[inp.dataset.list];
    inp.addEventListener('mousedown', () => render(inp, all.slice(0, firstPage)));
    inp.addEventListener('input', () => setTimeout(() => { if (inp.value) render(inp, all.filter((o) => o.toLowerCase().startsWith(inp.value.toLowerCase()))); }, 250));
  });
}
const combo = (id, label, kind) => `<div><label for="${id}">${label}</label><input id="${id}" role="combobox" data-list="${kind}"></div>`;
const plain = (id, label, extra = '') => `<div><label for="${id}">${label}</label><input id="${id}" ${extra}></div>`;

(async () => {
  // ---------- Greenhouse-style form ----------
  {
    const w = fromFixture('form.html', {
      firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '555-0100', linkedin: 'https://linkedin.com/in/ada',
      workAuth: 'Yes', sponsorship: 'No', customQA: [{ q: 'how did you hear', a: 'LinkedIn' }] });
    await w.__jobAutofill();
    const d = w.document;
    check('greenhouse: text fields', [val(d, 'first_name'), val(d, 'last_name'), val(d, 'email'), val(d, 'phone'), val(d, 'q1')],
      ['Ada', 'Lovelace', 'ada@example.com', '555-0100', 'https://linkedin.com/in/ada']);
    check('greenhouse: saved answer, select and radio', [val(d, 'q2'), val(d, 'q3'), [...d.querySelectorAll('[name=question_1004]')].map((r) => r.checked)],
      ['LinkedIn', 'Yes', [false, true]]);
  }

  // ---------- SuccessFactors application (generic labels, EEO, search boxes) ----------
  {
    const w = fromFixture('successfactors.html', {
      firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '555-0100', salary: '$75,000', country: 'United States',
      over18: 'Yes', restrictive: 'No', workAuth: 'Yes', sponsorship: 'No', referral: 'No', previousEmployee: 'No',
      veteran: 'No', disability: 'No', race: 'Asian', gender: 'Female' });
    const r = await w.__jobAutofill();
    const d = w.document;
    check('successfactors: question dropdowns', ['s18', 'srs', 'sauth', 'sspon', 'sref', 'sprev'].map((i) => val(d, i)), ['Yes', 'No', 'Yes', 'No', 'No', 'No']);
    check('successfactors: EEO', ['sfur', 'sgen', 'srace', 'svet', 'sdis'].map((i) => val(d, i)),
      ['Yes', 'Female', 'Asian (Not Hispanic or Latino)', 'I am not a protected veteran', 'No, I do not have a disability and have not had one in the past']);
    check('successfactors: names, country, left alone', [val(d, 'nm'), val(d, 'cty'), val(d, 'sl'), val(d, 'kw'), val(d, 'cookie'), val(d, 'sagree')],
      ['Ada Lovelace', 'United States', '', '', '', 'No Selection']);
    check('successfactors: only the agreement is unmatched', r.unmatched.length, 1);
  }

  // ---------- Workday: work/education sections with typed dates ----------
  {
    const w = fromFixture('workday-experience.html', {
      workExperience: [{ title: 'Facilities Intern', company: 'Acme', location: 'Chicago, IL', fromMonth: '06', fromYear: '2025', toMonth: '08', toYear: '2025', description: 'Did things' },
        { title: 'Lab Assistant', company: 'UIUC', current: true, fromMonth: '9', fromYear: '2024' }],
      education: [{ school: 'University of Illinois Urbana Champaign', degree: "Bachelor's", field: 'Mechanical Engineering', gpa: '3.8', fromMonth: '8', fromYear: '2023', toMonth: '5', toYear: '2027' }] });
    await w.__jobAutofill();
    const d = w.document;
    check('workday: job 1', ['w1t', 'w1c', 'w1l', 'w1sm', 'w1sy', 'w1em', 'w1ey'].map((i) => val(d, i)), ['Facilities Intern', 'Acme', 'Chicago, IL', '06', '2025', '08', '2025']);
    check('workday: job 2 added, current', [val(d, 'w1t_2'), val(d, 'w1c_2'), d.getElementById('w1cur_2').checked, val(d, 'w1sm_2'), val(d, 'w1em_2')], ['Lab Assistant', 'UIUC', true, '09', '']);
    check('workday: education', ['e1s', 'e1d', 'e1f', 'e1g', 'e1fm', 'e1fy', 'e1tm', 'e1ty'].map((i) => val(d, i)),
      ['University of Illinois Urbana Champaign', "US - General Education - Bachelor's Degree of Science", 'Mechanical Engineering', '3.8', '08', '2023', '05', '2027']);
  }

  // ---------- Country dropdown: never a wrong country ----------
  {
    const COUNTRIES = ['No Selection', 'Afghanistan', 'Albania', 'Anguilla', 'Argentina', 'Aruba', 'Australia', 'Austria', 'Canada', 'Mexico', 'United Kingdom', 'United States', 'United States Minor Outlying Islands', 'Uruguay'];
    for (const [label, onClick, expected] of [['list shows only the first page', undefined, 'United States'], ['widget swaps in Australia on click', () => 'Australia', '']]) {
      const w = loadPage(`<h3>Profile Information</h3>${combo('c', '* Present Country of Residence', 'country')}`, { country: 'United States' });
      paginated(w, { country: COUNTRIES }, { onClick });
      await w.__jobAutofill();
      check(`country: ${label}`, val(w.document, 'c'), expected);
    }
  }

  // ---------- Skills: type, press Enter, pick from the list ----------
  {
    const CATALOG = ['Python (Programming Language)', 'Python', 'SolidWorks', 'MATLAB'];
    const w = loadPage('<div data-automation-id="formField-skills"><label for=sk>Skills</label><div data-automation-id="multiSelectContainer"><div id=chips></div><input id=sk></div><div id=host></div></div>', { skills: ['Python', 'SolidWorks', 'Underwater Basket Weaving', 'MATLAB'] });
    const d = w.document;
    const inp = d.getElementById('sk');
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      setTimeout(() => {
        const v = inp.value.toLowerCase();
        d.getElementById('host').innerHTML = '';
        CATALOG.filter((c) => v && c.toLowerCase().includes(v)).forEach((t) => {
          const row = d.createElement('div');
          row.innerHTML = `<span>${t}</span><span>Skill</span>`;
          row.addEventListener('click', () => { const c = d.createElement('div'); c.setAttribute('data-automation-id', 'selectedItem'); c.textContent = t; d.getElementById('chips').append(c); inp.value = ''; d.getElementById('host').innerHTML = ''; });
          d.getElementById('host').append(row);
        });
      }, 400);
    });
    const r = await w.__jobAutofill();
    check('skills: selected from the results list', [...d.getElementById('chips').children].map((c) => c.textContent), ['Python', 'SolidWorks', 'MATLAB']);
    check('skills: missing skill reported', r.unmatched.some((u) => /Underwater Basket Weaving/.test(u)), true);
  }

  // ---------- Languages: "Language N" blocks ----------
  {
    const LV = '<option>Select One</option><option>Beginner</option><option>Intermediate</option><option>Advanced</option><option>Fluent</option>';
    const block = (n) => `<div><h3>Language ${n}</h3><label for="lg${n}">Language *</label><select id="lg${n}"><option>Select One</option><option>English</option><option>Spanish</option><option>Korean</option></select>
      <label><input type="checkbox" id="fl${n}"> I am fluent in this language.</label>${['Comprehension', 'Overall', 'Reading', 'Speaking', 'Writing'].map((k) => `<label for="${k}${n}">${k} *</label><select id="${k}${n}">${LV}</select>`).join('')}</div>`;
    const w = loadPage(`<div>${block(1)}<button id=add>Add Another</button></div>`, { languages: [{ language: 'English', proficiency: 'Native' }, { language: 'Spanish', proficiency: 'Intermediate' }, { language: 'Korean', proficiency: 'Advanced' }] });
    const d = w.document;
    d.getElementById('add').onclick = () => { const n = d.querySelectorAll('h3').length + 1; const t = d.createElement('div'); t.innerHTML = block(n); d.getElementById('add').before(t.firstChild); };
    await w.__jobAutofill();
    check('languages: three blocks', [1, 2, 3].map((n) => [val(d, 'lg' + n), d.getElementById('fl' + n).checked, val(d, 'Speaking' + n)]),
      [['English', true, 'Select One'], ['Spanish', false, 'Intermediate'], ['Korean', false, 'Advanced']]);
  }

  // ---------- Veteran / race wording ----------
  {
    const VET = ['No Selection', 'I AM NOT A PROTECTED VETERAN', 'I DO NOT CHOOSE TO SELF IDENTIFY', 'I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERAN LISTED ABOVE'];
    const notice = '<p>If you believe you belong to any of the categories of protected veterans listed above, please indicate by checking the appropriate box below. As a government contractor subject to VEVRAA, we request this information. This information is being requested on a voluntary basis and will be kept confidential. Refusal to provide it will not subject you to any adverse treatment. If provided, this information will not be used in a manner inconsistent with VEVRAA.</p>';
    for (const [setting, expected] of [['', 'I DO NOT CHOOSE TO SELF IDENTIFY'], ['No', 'I AM NOT A PROTECTED VETERAN'], ['Yes', VET[3]]]) {
      const w = loadPage(`<form>${notice}<label for=v>Please select one of the options*</label><select id=v>${VET.map((o) => `<option>${o}</option>`).join('')}</select></form>`, { veteran: setting });
      await w.__jobAutofill();
      check(`veteran "${setting || 'blank'}"`, val(w.document, 'v'), expected);
    }
  }

  // ---------- SuccessFactors profile page (shaped like a real field report) ----------
  {
    const LISTS = { country: ['Afghanistan', 'Albania', 'Angola', 'Anguilla', 'Argentina', 'Armenia', 'Aruba', 'Australia', 'Austria', 'Azerbaijan', 'Canada', 'South Korea', 'United Kingdom', 'United States', 'Uruguay'],
      state: ['Illinois', 'Indiana', 'Iowa'], business: ['Business Development', 'Engineering', 'Robotics'], employment: ['Full Time', 'Part Time', 'Intern'],
      degree: ['NONE', "Associate's Degree", "Bachelor's Degree"], major: ['Computer Science', 'Physics', 'Other'] };
    const date = (id, label) => `<div><ui5-date-picker data-id="${id}" data-label="${label}"></ui5-date-picker></div>`;
    const job = (n) => date('from' + n, 'From Date') + date('end' + n, 'End Date') + plain('co' + n, '* Company Name') + combo('biz' + n, '* Type of Business', 'business') +
      combo('cc' + n, '* Company Country', 'country') + plain('cs' + n, 'Company State/Province', 'disabled') + plain('ci' + n, '* Company City') + plain('ti' + n, '* Position Title') + combo('em' + n, 'Employment Type', 'employment');
    const html = `<div role="search" style="display:none"><input id="kw" placeholder="Search by keyword"></div><h3>Profile Information</h3>
      ${plain('fn', '* Legal First Name:')}${plain('a1', '* Present Address (Number, Street and Apt. Number)')}${plain('a2', 'Address Line 2')}
      ${combo('pco', '* Present Country of Residence', 'country')}${combo('pst', '* Present State/Province', 'state')}${plain('pci', '* Present City')}${plain('ph2', 'Secondary Phone:')}
      <h3>External Work Experience</h3>${job(1)}${job(2)}${job(3)}
      <h3>Education</h3>${combo('eco', 'Country', 'country')}${plain('eci', 'City')}${plain('sch', '* School/Institution Name')}${combo('maj', 'Major', 'major')}${plain('omj', 'If other, enter major')}`;
    const w = loadPage(html, {
      firstName: 'Ada', address: '1 Main St', city: 'Urbana', state: 'Illinois', country: 'United States',
      workExperience: [
        { title: 'Engineering Intern', company: 'Acuris', location: 'Seoul', country: 'South Korea', employmentType: 'Internship', industry: 'Engineering', fromMonth: '07', fromYear: '2026', toMonth: '09', toYear: '2026' },
        { title: 'Design Team Member', company: 'Illinois Robotics', location: 'Champaign', country: 'United States', employmentType: 'Part-time', industry: 'Robotics', fromMonth: '08', fromYear: '2023', toMonth: '05', toYear: '2024' },
        { title: 'Team Member', company: 'iRobotics', location: 'Champaign', country: 'United States', employmentType: 'Part-time', industry: 'Robotics', fromMonth: '01', fromYear: '2026', current: true }],
      education: [{ school: 'University of Illinois', degree: "Bachelor's", field: 'Mechanical Engineering' }] });
    const d = w.document;
    d.querySelectorAll('ui5-date-picker').forEach((h) => { h.attachShadow({ mode: 'open' }).innerHTML = `<input id="inner" aria-label="${h.dataset.label}" placeholder="MM/DD/YYYY">`; });
    for (const n of [1, 2, 3]) d.getElementById('cs' + n).disabled = true;
    paginated(w, LISTS);
    await w.__jobAutofill();
    const g = (id) => { const e = d.getElementById(id); return e ? e.value : d.querySelector(`ui5-date-picker[data-id="${id}"]`).shadowRoot.getElementById('inner').value; };
    check('profile page: home address', ['fn', 'a1', 'a2', 'pco', 'pst', 'pci', 'ph2'].map(g), ['Ada', '1 Main St', '', 'United States', 'Illinois', 'Urbana', '']);
    check('profile page: job 1', ['from1', 'end1', 'co1', 'biz1', 'cc1', 'ci1', 'ti1', 'em1'].map(g), ['07/01/2026', '09/30/2026', 'Acuris', 'Engineering', 'South Korea', 'Seoul', 'Engineering Intern', 'Intern']);
    check('profile page: job 2', ['from2', 'end2', 'co2', 'biz2', 'cc2', 'ti2', 'em2'].map(g), ['08/01/2023', '05/31/2024', 'Illinois Robotics', 'Robotics', 'United States', 'Design Team Member', 'Part Time']);
    check('profile page: job 3 current (no end date)', ['from3', 'end3', 'co3'].map(g), ['01/01/2026', '', 'iRobotics']);
    check('profile page: education country/city untouched', [g('eco'), g('eci')], ['', '']);
    check('profile page: major not listed -> Other + helper', [g('maj'), g('omj')], ['Other', 'Mechanical Engineering']);
    check('profile page: hidden search untouched', g('kw'), '');
  }

  // ---------- Reused popup nodes: language 2, yes/no, ethnicity, major worded differently ----------
  {
    const LISTS = { lang: ['Arabic', 'Chinese', 'English', 'French', 'German', 'Hindi', 'Japanese', 'Korean', 'Spanish'], yesno: ['Yes', 'No'], eth: ['Hispanic or Latino', 'Asian', 'White'], degree: ["Associate's Degree", "Bachelor's Degree"], major: ['Business', 'Engineering - Mechanical', 'Other'] };
    const w = loadPage(`<h3>Education</h3>${plain('sch', '* School/Institution Name')}${combo('maj', '* Major', 'major')}${plain('omj', 'If other, enter area of study')}${combo('deg', 'Degree', 'degree')}
      <h3>Languages</h3>${combo('l1', '* Language', 'lang')}${combo('l2', '* Language', 'lang')}<h3>Questions</h3>${combo('wa', 'Are you legally authorized to work in the United States on a permanent basis', 'yesno')}${combo('eth', 'Ethnicity', 'eth')}`,
    { workAuth: 'Yes', race: 'Asian', education: [{ school: 'U of I', degree: "Bachelor's", field: 'Mechanical Engineering', toMonth: '05', toYear: '2028' }],
      languages: [{ language: 'English', proficiency: 'Native' }, { language: 'Korean', proficiency: 'Advanced' }] });
    paginated(w, LISTS);
    await w.__jobAutofill();
    const d = w.document;
    check('reused nodes: major by words, degree, languages, yes/no, ethnicity', ['maj', 'omj', 'deg', 'l1', 'l2', 'wa', 'eth'].map((i) => val(d, i)),
      ['Engineering - Mechanical', '', "Bachelor's Degree", 'English', 'Korean', 'Yes', 'Asian']);
  }

  // ---------- Armstrong-style rows and education questions ----------
  {
    const LISTS = { business: ['Engineering', 'Robotics'], ptype: ['Full Time', 'Part Time', 'Intern'], edu: ['High School', "Bachelor's Degree", "Master's Degree"], disc: ['Business', 'Engineering'] };
    const date = (id, label) => `<div><ui5-date-picker data-id="${id}" data-label="${label}"></ui5-date-picker></div>`;
    const row = (n) => date('f' + n, 'From Date') + date('e' + n, 'End Date') + plain('co' + n, '* Company Name') + combo('tb' + n, 'Type of Business', 'business') + plain('ti' + n, '* Title') + combo('pt' + n, 'Position Type', 'ptype') + combo('rl' + n, 'Reason for Leaving', 'business');
    const w = loadPage(`${row(1)}${row(2)}${combo('he', 'What is your highest level of education achieved', 'edu')}${combo('hd', 'In which discipline did you receive your highest level of education', 'disc')}${plain('gd', 'graduation date (or anticipated date)')}`,
      { workExperience: [{ title: 'Intern', company: 'Acme', employmentType: 'Internship', industry: 'Robotics', fromMonth: '06', fromYear: '2025', toMonth: '08', toYear: '2025' }, { title: 'Lead', company: 'Beta', employmentType: 'Full-time', fromMonth: '01', fromYear: '2026', current: true }],
        education: [{ school: 'U', degree: "Bachelor's", field: 'Engineering', toMonth: '05', toYear: '2030' }] });
    const d = w.document;
    d.querySelectorAll('ui5-date-picker').forEach((h) => { h.attachShadow({ mode: 'open' }).innerHTML = `<input id="inner" aria-label="${h.dataset.label}" placeholder="MM/DD/YYYY">`; });
    d.getElementById('gd').placeholder = 'MM/DD/YYYY';
    paginated(w, LISTS);
    const r = await w.__jobAutofill();
    const g = (id) => { const e = d.getElementById(id); return e ? e.value : d.querySelector(`ui5-date-picker[data-id="${id}"]`).shadowRoot.getElementById('inner').value; };
    check('armstrong rows: job 1 and 2', [['co1', 'ti1', 'pt1', 'tb1', 'rl1', 'f1', 'e1'], ['co2', 'ti2', 'pt2', 'f2', 'e2']].map((ids) => ids.map(g)),
      [['Acme', 'Intern', 'Intern', 'Robotics', '', '06/01/2025', '08/31/2025'], ['Beta', 'Lead', 'Full Time', '01/01/2026', '']]);
    check('highest education while still studying, graduation date', [g('he'), g('hd'), g('gd')], ['High School', '', '05/31/2030']);
    check('discipline left for you when no degree is finished', r.unmatched.some((u) => /discipline/.test(u)), true);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();

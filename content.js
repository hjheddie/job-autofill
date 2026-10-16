// Injected on demand (activeTab) into every frame of the current page.
// Exposes window.__jobAutofill(profile?) -> { filled: [...], unmatched: [...] }
(() => {
  const AUTOCOMPLETE = {
    'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName',
    email: 'email', tel: 'phone', 'tel-national': 'phone',
    'address-level2': 'city', 'address-level1': 'state', 'postal-code': 'zip',
    country: 'country', 'country-name': 'country', 'street-address': 'address',
    'address-line1': 'address', organization: 'currentCompany',
    'organization-title': 'currentTitle', url: 'portfolio',
  };

  // Order matters: question-style rules first, short-label rules last.
  const RULES = [
    ['over18', /at least 18|18 years|over 18|eighteen/],
    ['restrictive', /restrictive covenant|non-?compete|confidentiality agreement|contractual obligation/],
    ['previousEmployee', /ever (been )?employed|previously (been )?employed|former employee|worked for .{0,40}(before|previously)/],
    ['referral', /referred by|employee referral/],
    ['relatedEmployee', /related to anyone|relatives? (that|who|working)|family member/],
    ['sponsorship', /sponsor/],
    ['workAuth', /authori[sz]ed to work|legally (authori[sz]ed|eligible)|work authori[sz]ation|eligible to work|right to work/],
    ['veteran', /veteran/],
    ['disability', /disabilit/],
    ['furnish', /wish to (furnish|provide|disclose|self)|furnish this information/],
    ['gender', /\bgender\b|\bsex\b/],
    ['hispanic', /hispanic|latino/],
    ['race', /\brace\b|ethnic/],
    ['email', /e-?mail/],
    ['phoneExt', /extension|\bext\b/],
    ['phoneCountryCode', /phone code|country code|dial(ing)? code|phone.*country|country.*phone/],
    ['phoneType', /device type|phone type|type of phone/],
    ['phone', /phone|mobile|telephone/],
    ['secondLastName', /second last name|second surname|maternal/],
    ['middleName', /middle (name|initial)/],
    ['firstName', /first.?name|given.?name|legal first|preferred first/],
    ['lastName', /last.?name|family.?name|surname|legal last/],
    ['fullName', /^(full |legal |your )?name$|full.?name|legal name/],
    ['linkedin', /linkedin/],
    ['github', /github/],
    ['portfolio', /portfolio|personal (web)?site|website|^url$/],
    ['currentCompany', /current (company|employer)|^(company|employer)( name)?$/],
    ['currentTitle', /current (job )?title|^job title$/],
    ['school', /school|university|college|institution/, 80],
    ['degree', /\bdegree\b/, 60],
    ['gpa', /\bgpa\b|grade point|overall result/, 60],
    ['major', /major|field of study|discipline/, 60],
    ['salary', /salary|compensation/],
    ['city', /\bcity\b/, 40],
    ['state', /\bstate\b|province/, 40],
    ['zip', /zip|postal/, 40],
    ['country', /country/, 40],
    ['address', /street|address/, 40],
  ];

  const DECLINE = /decline|prefer not|do not wish|don'?t wish|not to (say|disclose|answer)|choose not/;
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search', 'range', 'color']);

  const norm = (s) => (s || '').toLowerCase().replace(/[*:?]/g, ' ').replace(/\s+/g, ' ').trim();
  const txt = (n) => (n.innerText ?? n.textContent ?? '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function collect(root, out) {
    root.querySelectorAll('input, select, textarea, button[aria-haspopup=listbox], [role=combobox]:not(input)')
      .forEach((el) => out.push(el));
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) collect(el.shadowRoot, out); });
    return out;
  }

  function byId(el, id) {
    const root = el.getRootNode();
    return (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
  }

  const NOISE = /\b(please select one of the options|select one of the options|no selection|select one|please select|choose( one)?|required|optional)\b|-\s*select\s*-/g;
  // A label that says nothing about the question ("Please select one of the options").
  const isGeneric = (label) => label.replace(/\b(please|of the options|no selection|select|one)\b/g, '').trim().length < 3;

  // Text of the nearest preceding block that isn't itself a generic label: usually the question.
  function contextBefore(el) {
    let node = el;
    for (let depth = 0; depth < 5 && node && node !== document.body; depth++, node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        const t = norm(txt(sib).replace(NOISE, ' '));
        if (t.length >= 15 && !isGeneric(t)) return t.slice(-300);
      }
    }
    return '';
  }

  // Option text identifies EEO-style selects whose label is generic (veteran, disability, ...).
  const OPTION_RULES = ['veteran', 'disability', 'gender', 'race', 'hispanic'];

  function labelText(el) {
    const parts = [];
    // Workday-style wrapper: <div data-automation-id="formField-..."><label>…</label>…</div>
    const wrap = el.closest('[data-automation-id^="formField"]');
    const wl = wrap && wrap.querySelector('label, legend');
    if (wl) parts.push(txt(wl));
    if (el.labels) for (const l of el.labels) parts.push(txt(l));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) lb.split(/\s+/).forEach((id) => { const n = byId(el, id); if (n) parts.push(txt(n)); });
    parts.push(el.getAttribute('aria-label') || '', el.placeholder || '');
    if (!parts.join('').trim()) {
      const legend = el.closest('fieldset')?.querySelector('legend');
      const before = legend ? '' : contextBefore(el);
      if (legend) parts.push(txt(legend));
      else if (before) parts.push(before);
      else {
        const c = el.closest('[class*=field],[class*=question],[class*=form-group],li') || el.parentElement;
        if (c) parts.push(txt(c).slice(0, 160));
      }
    }
    const seen = new Set();
    const uniq = parts.map((x) => norm(x.replace(NOISE, ' '))).filter((x) => x && !seen.has(x) && seen.add(x));
    return uniq.join(' ');
  }

  function questionText(group) {
    const el = group[0];
    const legend = el.closest('fieldset')?.querySelector('legend');
    if (legend) return norm(txt(legend));
    const rg = el.closest('[role=radiogroup],[role=group]');
    if (rg) return norm((rg.getAttribute('aria-label') || '') + ' ' + txt(rg).slice(0, 200));
    const c = el.parentElement?.parentElement?.parentElement;
    return norm(c ? txt(c).slice(0, 200) : '');
  }

  function classify(el, label) {
    const ac = (el.getAttribute('autocomplete') || '').split(/\s+/).pop();
    const hay = norm(`${label} ${el.name || ''} ${el.id || ''}`.replace(/[_\-[\]]/g, ' '));
    // Specific rules by label/name text win over autocomplete (e.g. "name" fields).
    for (const [key, re, max] of RULES) {
      if (max && label.length > max) continue; // length limit applies to the visible label only
      if (re.test(hay)) return key;
    }
    return AUTOCOMPLETE[ac] || null;
  }

  function valueFor(key, p) {
    switch (key) {
      case 'fullName': return [p.firstName, p.lastName].filter(Boolean).join(' ');
      case 'phoneExt': case 'secondLastName': return '';
      case 'middleName': return p.middleName || '';
      case 'furnish': // "Do you wish to furnish this information?": No unless some EEO answer was given
        return p.furnish || (['gender', 'race', 'hispanic', 'veteran', 'disability']
          .every((k) => !p[k] || /^decline$/i.test(p[k])) ? 'No' : 'Yes');
      case 'phoneCountryCode': return p.phoneCountryCode || p.country || 'United States';
      case 'phoneType': return p.phoneType || 'Mobile';
      case 'gender': case 'race': case 'hispanic': case 'veteran': case 'disability': return p[key] || 'Decline';
      // Fall back to the saved lists so single-field forms still get filled.
      case 'school': case 'gpa': return p[key] || (p.education?.[0] || {})[key] || '';
      case 'degree': return p.degree || p.education?.[0]?.degree || '';
      case 'major': return p.major || p.education?.[0]?.field || '';
      case 'currentCompany': return p.currentCompany || p.workExperience?.[0]?.company || '';
      case 'currentTitle': return p.currentTitle || p.workExperience?.[0]?.title || '';
      default: return p[key] || '';
    }
  }

  function pickOption(texts, answer) {
    const a = norm(answer);
    if (!a) return -1;
    const t = texts.map(norm);
    if (a === 'decline') return t.findIndex((x) => DECLINE.test(x));
    let i = t.findIndex((x) => x === a);
    if (i < 0) i = t.findIndex((x) => x.startsWith(a));
    if (i < 0) i = t.findIndex((x) => x.length > 1 && x.includes(a));
    if (i < 0) i = t.findIndex((x) => x.length > 1 && a.includes(x));
    return i;
  }

  // Spelling variants for the same answer, most specific first ("IL" -> Illinois, IL).
  function variants(key, answer) {
    const D = window.JA_DATA || { STATES: {}, COUNTRY_ALIASES: {} };
    const a = String(answer).trim();
    const out = [a];
    if (key === 'state') {
      const abbr = Object.keys(D.STATES).find((k) => k === a.toUpperCase() || norm(D.STATES[k]) === norm(a));
      if (abbr) out.unshift(D.STATES[abbr]), out.push(abbr);
    } else if (key === 'veteran' || key === 'disability') {
      const yes = /^yes/i.test(a);
      const no = /^no/i.test(a);
      if (key === 'veteran') {
        if (no) out.unshift('I am not a protected veteran', 'not a protected veteran');
        if (yes) out.unshift('I identify as one or more of the classifications of protected veteran', 'protected veteran');
      } else {
        if (no) out.unshift('No, I do not have a disability', 'No, I do not have a disability and have not had one');
        if (yes) out.unshift('Yes, I have a disability', 'Yes, I have a disability, or have had one');
      }
    } else if (key === 'hispanic') {
      if (/^yes/i.test(a)) out.unshift('Hispanic or Latino');
      if (/^no/i.test(a)) out.unshift('Not Hispanic or Latino');
    } else if (key === 'degree') {
      const n = norm(a);
      const levels = [
        [/bachelor|\bb\.?\s?[sa]\b|undergrad/, ["Bachelor's Degree", 'Bachelor']],
        [/master|\bm\.?\s?[sa]\b|mba/, ["Master's Degree", 'Master']],
        [/associate/, ["Associate's Degree", 'Associate']],
        [/phd|doctor/, ['Doctor', 'PhD', 'Doctorate']],
        [/high school|ged/, ['High School']],
      ];
      for (const [re, alts] of levels) if (re.test(n)) { out.push(...alts); break; }
    } else if (key === 'country' || key === 'phoneCountryCode') {
      const n = norm(a);
      for (const [base, alts] of Object.entries(D.COUNTRY_ALIASES)) {
        // Official long form first, so "United States" doesn't hit "United States Minor Outlying Islands".
        if (n === base || alts.includes(n)) { out.unshift(alts[0]); out.push(base, ...alts); break; }
      }
    }
    return [...new Set(out)];
  }

  function pickAny(texts, answers) {
    for (const a of answers) { const i = pickOption(texts, a); if (i >= 0) return i; }
    return -1;
  }

  const visibleOptions = () => [...document.querySelectorAll('[role=option], [role=listbox] li')]
    .filter((o) => o.offsetParent !== null || o.getClientRects().length);

  const isEmptyChoice = (s) => !s || /^(select one|select|choose( one)?|please select|--+|—)$/i.test(s.trim());

  function setNative(el, v) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const mark = (el) => { el.style.outline = '2px solid #22c55e'; el.style.outlineOffset = '1px'; };

  async function fillCombobox(el, answers) {
    el.focus();
    setNative(el, answers[0]);
    await sleep(350);
    const opts = visibleOptions();
    const i = pickAny(opts.map((o) => txt(o)), answers);
    if (i < 0) { setNative(el, ''); el.blur(); return false; }
    opts[i].click();
    return true;
  }

  // Button-style dropdowns (Workday etc.): click to open, pick from the popup list.
  async function fillListbox(el, answers) {
    el.click();
    let opts = [];
    for (let t = 0; t < 4 && !opts.length; t++) { await sleep(250); opts = visibleOptions(); }
    const i = pickAny(opts.map((o) => txt(o)), answers);
    if (i < 0) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }
    opts[i].click();
    await sleep(150);
    return true;
  }

  function fillSelect(el, answers) {
    const opts = [...el.options];
    const i = pickAny(opts.map((o) => o.text), answers);
    if (i < 0) return false;
    el.selectedIndex = i;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function b64ToFile(r) {
    const bin = atob(r.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], r.name, { type: r.type || 'application/pdf' });
  }

  function customAnswer(label, p) {
    for (const qa of p.customQA || []) {
      const q = norm(qa.q);
      if (q && label.includes(q)) return qa.a;
    }
    return null;
  }

  // ---- Repeating sections: "Work Experience 1", "Education 1", … (Workday "My Experience") ----
  const KINDS = {
    work: { heading: /^work experience \d+$/, other: /^education \d+$/, list: 'workExperience', minControls: 5 },
    edu: { heading: /^education \d+$/, other: /^work experience \d+$/, list: 'education', minControls: 4 },
  };
  const CONTROLS = 'input, select, textarea, button[aria-haspopup=listbox]';

  const headingsIn = (root, re) => [...root.querySelectorAll('*')]
    .filter((n) => !n.children.length && txt(n).length < 40 && re.test(norm(txt(n))));

  function sectionRoots(kind) {
    const roots = [];
    for (const h of headingsIn(document, kind.heading)) {
      let prev = null;
      for (let c = h.parentElement; c && c !== document.body; prev = c, c = c.parentElement) {
        if (headingsIn(c, kind.heading).length > 1 || headingsIn(c, kind.other).length) break;
        if (c.querySelectorAll(CONTROLS).length >= kind.minControls) { prev = c; break; }
      }
      if (prev && !roots.includes(prev)) roots.push(prev);
    }
    return roots;
  }

  function sectionFields(root) {
    const f = { months: [], years: [] };
    const textRules = [
      ['title', /job title|^title$/], ['company', /company|employer/], ['location', /location/],
      ['description', /description|responsib/], ['school', /school|universit|college/],
      ['gpa', /gpa|overall result|grade/], ['degree', /\bdegree\b/], ['field', /field of study|major/],
    ];
    for (const el of root.querySelectorAll(CONTROLS)) {
      const type = (el.type || '').toLowerCase();
      if ((el.tagName === 'INPUT' && ['hidden', 'submit', 'button', 'file', 'radio'].includes(type)) || el.disabled) continue;
      if (type === 'checkbox') { if (/currently|current/.test(labelText(el))) f.current = el; continue; }
      const own = norm([el.id, el.name, el.getAttribute('data-automation-id'), el.getAttribute('aria-label'), el.placeholder]
        .filter(Boolean).join(' ').replace(/[_\-[\]]/g, ' '));
      if (/month|\bmm\b/.test(own)) { f.months.push(el); continue; }
      if (/year|yyyy/.test(own)) { f.years.push(el); continue; }
      const label = labelText(el);
      const hay = `${label} ${own}`;
      const hit = textRules.find(([k, re]) => !f[k] && re.test(hay));
      if (hit) f[hit[0]] = el;
    }
    return f;
  }

  const isListboxEl = (el) => el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA';

  async function setControl(el, value, key) {
    const answers = variants(key, value);
    if (el instanceof HTMLSelectElement) return fillSelect(el, answers);
    if (isListboxEl(el)) return isEmptyChoice(txt(el)) ? fillListbox(el, answers) : true;
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') {
      return fillCombobox(el, answers);
    }
    setNative(el, value);
    return true;
  }

  // ---- Date inputs that only count a value typed like a user (Workday MM / YYYY) ----
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shown = (n) => n.offsetParent !== null || n.getClientRects().length > 0;

  function key(el, type, ch) {
    const code = ch.charCodeAt(0);
    return el.dispatchEvent(new KeyboardEvent(type, {
      key: ch, code: /\d/.test(ch) ? 'Digit' + ch : ch, keyCode: code, which: code,
      bubbles: true, cancelable: true, composed: true,
    }));
  }

  function insertChar(el, ch) {
    const before = el.value;
    el.dispatchEvent(new InputEvent('beforeinput', { data: ch, inputType: 'insertText', bubbles: true, cancelable: true }));
    if (el.value !== before) return; // the page's own handler already took it
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, before + ch);
    el.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true }));
  }

  // Focus, type digit by digit with real key events, then blur so the field "commits".
  async function typeDate(el, text) {
    el.focus();
    el.click();
    for (const ch of String(text)) {
      if (key(el, 'keydown', ch)) { key(el, 'keypress', ch); insertChar(el, ch); }
      key(el, 'keyup', ch);
      await sleep(25);
    }
    if (el.value.replace(/\D/g, '') !== String(text)) setNative(el, String(text)); // last resort
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    el.blur();
    await sleep(60);
    return true;
  }

  function isInvalid(el) {
    const wrap = el.closest('[data-automation-id^="formField"]') || el.parentElement;
    return el.getAttribute('aria-invalid') === 'true'
      || [...wrap.querySelectorAll('[data-automation-id*="error" i]')].some(shown);
  }

  // Fallback: drive the calendar popup (year arrows, then month cell).
  async function pickDate(anchor, month, year) {
    const wrap = anchor.closest('[data-automation-id^="formField"]') || anchor.parentElement;
    const icon = wrap.querySelector('[data-automation-id*="dateIcon" i], [data-automation-id*="calendar" i], button[aria-label*="calendar" i], button[aria-label*="date" i]');
    if (!icon) return false;
    icon.click();
    await sleep(400);
    const pop = [...document.querySelectorAll('[role=dialog], [data-automation-id*="datePicker" i], [data-automation-id*="popup" i]')].find(shown);
    if (!pop) return false;
    const yearEl = () => [...pop.querySelectorAll('*')].find((n) => !n.children.length && /^\d{4}$/.test(txt(n).trim()));
    let header = yearEl();
    while (header && header !== pop && header.querySelectorAll('button, [role=button]').length < 2) header = header.parentElement;
    const btns = header ? [...header.querySelectorAll('button, [role=button]')] : [];
    const label = (b) => b.getAttribute('aria-label') || '';
    const prev = btns.find((b) => /prev|back|left/i.test(label(b))) || btns[0];
    const next = btns.find((b) => /next|forward|right/i.test(label(b))) || btns[btns.length - 1];
    for (let i = 0; i < 60 && yearEl(); i++) {
      const cur = Number(txt(yearEl()).trim());
      if (cur === Number(year)) break;
      (cur > Number(year) ? prev : next)?.click();
      await sleep(120);
    }
    const name = MONTH_NAMES[Number(month) - 1];
    const cell = [...pop.querySelectorAll('button, [role=button], [role=gridcell], li, div')]
      .find((n) => txt(n).trim() === name && shown(n));
    if (cell) cell.click();
    await sleep(250);
    return !!cell;
  }

  function addButtonAfter(root) {
    return [...document.querySelectorAll('button, [role=button]')].find((b) =>
      /^add( another)?$/i.test(txt(b).trim()) && !root.contains(b)
      && (root.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
  }

  async function fillSections(p, filled, covered) {
    for (const [name, kind] of Object.entries(KINDS)) {
      const entries = p[kind.list] || [];
      if (!entries.length) continue;
      let roots = sectionRoots(kind);
      // Click "Add Another" until the page has a block for every saved entry.
      for (let guard = 0; roots.length && roots.length < entries.length && guard < entries.length; guard++) {
        const btn = addButtonAfter(roots[roots.length - 1]);
        if (!btn) break;
        btn.click();
        await sleep(800);
        roots = sectionRoots(kind);
      }
      for (let i = 0; i < roots.length; i++) {
        covered.push(roots[i]);
        const e = entries[i];
        if (!e) continue;
        const f = sectionFields(roots[i]);
        const mm = (v) => (v ? String(v).padStart(2, '0') : '');
        const plan = name === 'work'
          ? [['title', e.title], ['company', e.company], ['location', e.location], ['description', e.description],
            [null, e.fromMonth, f.months[0], mm], [null, e.fromYear, f.years[0]],
            [null, e.current ? '' : e.toMonth, f.months[1], mm], [null, e.current ? '' : e.toYear, f.years[1]]]
          : [['school', e.school], ['degree', e.degree], ['field', e.field], ['gpa', e.gpa],
            [null, e.fromMonth, f.months[0], mm], [null, e.fromYear, f.years[0]],
            [null, e.toMonth, f.months[1], mm], [null, e.toYear, f.years[1]]];
        if (name === 'work' && e.current && f.current && !f.current.checked) f.current.click();
        for (const [key, value, ctl, fmt] of plan) {
          const el = ctl || f[key];
          const v = fmt ? fmt(value) : value;
          if (!el || !v) continue;
          if (!isListboxEl(el) && !(el instanceof HTMLSelectElement) && el.value) continue; // never overwrite
          if (await (key ? setControl(el, v, key) : typeDate(el, v))) {
            mark(el);
            filled.push({ label: `${name === 'work' ? 'Work' : 'Education'} ${i + 1}: ${key || 'date'}`, key: key || 'date' });
          }
        }
        // If the site still flags a date as empty, set it through its calendar popup instead.
        await sleep(150);
        const pairs = [
          [f.months[0], f.years[0], e.fromMonth, e.fromYear],
          [f.months[1], f.years[1], e.current ? '' : e.toMonth, e.current ? '' : e.toYear],
        ];
        for (const [mEl, yEl, mv, yv] of pairs) {
          if (mEl && yEl && mv && yv && isInvalid(yEl)) await pickDate(yEl, mm(mv), yv);
        }
      }
    }
  }

  window.__jobAutofill = async function (profileOverride) {
    const p = profileOverride || (await window.JA_PROFILES.active()) || {};
    const filled = [];
    const unmatched = [];
    const covered = [];
    await fillSections(p, filled, covered);
    const seen = new WeakSet();
    async function pass() {
      const els = collect(document, []).filter((el) => !seen.has(el) && !covered.some((r) => r.contains(el)));
      els.forEach((el) => seen.add(el));
      const radios = new Map();

      for (const el of els) {
        const isListbox = el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA';
        const type = isListbox ? 'listbox' : (el.type || '').toLowerCase();
        if (SKIP_TYPES.has(type) || el.disabled || el.readOnly) continue;
        if (type === 'checkbox') continue;
        if (type === 'radio') {
          const k = (el.name || '') + '|' + (el.form ? [...document.forms].indexOf(el.form) : '');
          if (!radios.has(k)) radios.set(k, []);
          radios.get(k).push(el);
          continue;
        }
        if (el.closest('[role=search], nav, header, [id*=cookie i], [class*=cookie i], [id*=onetrust i], [class*=onetrust i]')) continue;
        let label = labelText(el);
        if (/^search\b/.test(label)) continue;
        if (type !== 'file' && isGeneric(label)) label = (contextBefore(el) + ' ' + label).trim();

        if (type === 'file') {
          // Workday's hidden file input has no label of its own, so also read the surrounding block.
          const near = norm(txt(el.closest('[data-automation-id^="formField"], section, fieldset') || el.parentElement || el).slice(0, 200));
          const isResume = /resume|cv|curriculum/.test(`${label} ${el.name} ${el.id} ${near}`) && !/cover letter/.test(`${label} ${near}`);
          if (isResume && p.resume && !el.files.length) {
            const dt = new DataTransfer();
            dt.items.add(b64ToFile(p.resume));
            el.files = dt.files;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            filled.push({ label: 'Resume', key: 'resume' });
          }
          continue;
        }

        const isSelect = el instanceof HTMLSelectElement;
        const isCombo = el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list';
        // Multi-select search widgets already holding a chip (e.g. Country Phone Code).
        const wrapEl = el.closest('[data-automation-id^="formField"]');
        if (wrapEl && wrapEl.querySelector('[data-automation-id*="selectedItem" i]')) continue;
        if (isListbox) { if (!isEmptyChoice(txt(el))) continue; }
        else if (!isSelect && !isCombo && el.value) continue; // never overwrite
        if (isSelect && el.selectedIndex > 0) continue;

        let key = classify(el, label);
        if (!key && isSelect) {
          const opts = norm([...el.options].map((o) => o.text).join(' '));
          key = (RULES.find(([k, re]) => OPTION_RULES.includes(k) && re.test(opts)) || [])[0] || null;
        }
        let answer = customAnswer(label, p);
        if (answer == null && key) answer = valueFor(key, p);
        if (!answer) {
          const quiet = ['phoneExt', 'secondLastName', 'middleName'].includes(key) || /^if (yes|so|you)\b/.test(label);
          if (label && !quiet) unmatched.push(`${label.slice(0, 70)} — ${key ? `no "${key}" saved in your profile` : 'field not recognized'}`);
          continue;
        }
        const answers = variants(key, answer);

        let ok = false;
        if (isListbox) ok = await fillListbox(el, answers);
        else if (isSelect) ok = fillSelect(el, answers);
        else if (isCombo) ok = await fillCombobox(el, answers);
        else { setNative(el, answer); ok = true; }

        if (ok) { mark(el); filled.push({ label: label.slice(0, 60), key: key || 'custom' }); }
        else unmatched.push(`${label.slice(0, 70)} — no option matches "${answers[0]}"${answers[0] === 'Decline' ? ' (this list has no decline choice; pick one yourself)' : ''}`);
      }

      for (const group of radios.values()) {
        const q = questionText(group);
        const key = classify(group[0], q);
        const answer = customAnswer(q, p) ?? (key ? valueFor(key, p) : '');
        if (!answer) { unmatched.push(q.slice(0, 80)); continue; }
        const texts = group.map((r) => labelText(r) || r.value);
        const i = pickAny(texts, variants(key, answer));
        if (i < 0 || group.some((r) => r.checked)) continue;
        group[i].click();
        filled.push({ label: q.slice(0, 60), key: key || 'custom' });
      }

    }

    await pass();
    await sleep(500); // fields revealed by earlier answers (e.g. self-ID after "wish to furnish")
    await pass();

    return { filled, unmatched: [...new Set(unmatched)].slice(0, 25) };
  };
})();

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
    ['expectedGraduation', /expected graduation|anticipated graduation|expected completion/],
    ['graduationDate', /graduation date|date of graduation|date graduated|completion date/],
    ['degreeCompleted', /degree (been )?completed|completed (this|the) degree|degree completed/],
    ['over18', /at least 18|18 years|over 18|eighteen/],
    ['restrictive', /restrictive covenant|non-?compete|confidentiality agreement|contractual obligation/],
    ['previousEmployee', /ever (been )?employed|previously (been )?employed|former employee|worked for .{0,40}(before|previously)/],
    ['referral', /referred by|employee referral/],
    ['relatedEmployee', /related to anyone|relatives? (that|who|working)|family member/],
    ['sponsorship', /sponsor/],
    ['workAuth', /authori[sz]ed to work|legally (authori[sz]ed|eligible)|work authori[sz]ation|eligible to work|right to work/],
    ['veteran', /veteran|vevraa/],
    ['disability', /disabilit|cc-?305/],
    ['furnish', /wish to (furnish|provide|disclose|self)|furnish this information/],
    ['gender', /\bgender\b|\bsex\b/],
    ['hispanic', /hispanic|latino/],
    ['race', /\brace\b|ethnic/],
    ['email', /e-?mail/],
    ['secondaryPhone', /secondary phone|alternate phone|alt\.? phone|other phone|home phone|work phone/],
    ['phoneExt', /extension|\bext\b/],
    ['phoneCountryCode', /phone code|country code|dial(ing)? code|phone.*country|country.*phone/],
    ['phoneType', /device type|phone type|type of phone/],
    ['phone', /phone|mobile|telephone/],
    ['secondLastName', /second last name|second surname|maternal/],
    ['middleName', /middle (name|initial)/],
    ['preferredName', /preferred name|nickname|goes by/],
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
    ['skills', /\bskills?\b/],
    ['langProficiency', /(speaking|reading|writing|listening|comprehension|overall) proficiency|proficiency level/],
    ['languageName', /^language\b/],
    ['languages', /^(?!.*(programming|coding|markup)).*\blanguages?\b/],
    ['salary', /salary|compensation/],
    ['city', /\bcity\b/, 40],
    ['zip', /zip|postal/, 40],
    ['country', /country/, 40],
    ['state', /\bstate\b|province|^region\b/, 40],
    ['address2', /address line 2|address 2|line 2|\bsuite\b|\bunit\b/, 40],
    ['address', /street|address/, 60],
  ];

  const DECLINE = /decline|prefer not|do not (wish|want|choose)|don['’]?t (wish|want|choose)|not to (say|disclose|answer|furnish|identify)|choose not|self.?identify/;
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

  const NOISE = /\b(please select one of the options|select one of the options|no selection|select one|please select|choose( one)?|required|optional)\b|-\s*select\s*-/gi;
  // A label that says nothing about the question ("Please select one of the options").
  const isGeneric = (label) => label.replace(/\b(please|of the options|no selection|select|one)\b/g, '').trim().length < 3;

  // Text of the nearest preceding block that isn't itself a generic label: usually the question.
  function contextBefore(el) {
    let node = el;
    for (let depth = 0; depth < 5 && node && node !== document.body; depth++, node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        const t = norm(txt(sib).replace(NOISE, ' '));
        if (t.length >= 15 && !isGeneric(t)) return t.slice(0, 600);
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

  // A page section heading near the field ("Education", "External Work Experience", ...).
  function sectionHeading(el) {
    let node = el;
    for (let depth = 0; depth < 8 && node && node !== document.body; depth++, node = node.parentElement) {
      let sib = node.previousElementSibling;
      for (let n = 0; sib && n < 15; n++, sib = sib.previousElementSibling) {
        const h = sib.matches('h1,h2,h3,h4,h5,h6,legend,[role=heading]') ? sib : sib.querySelector('h1,h2,h3,h4,h5,h6,legend,[role=heading]');
        if (h && norm(txt(h))) return norm(txt(h));
      }
    }
    return '';
  }

  const PLACE_KEYS = new Set(['city', 'state', 'zip', 'country', 'address']);
  const HOME_QUAL = /\b(present|current|home|mailing|permanent|residential|residence)\b/;
  let homeQualified = new Set(); // place keys the page asks for explicitly as the home address
  function scanHomeFields(els) {
    homeQualified = new Set();
    for (const el of els) {
      const l = labelText(el);
      if (!HOME_QUAL.test(l)) continue;
      for (const [key, re] of RULES) if (PLACE_KEYS.has(key) && re.test(l)) homeQualified.add(key);
    }
  }
  const OTHER_PLACE = /company|employer|school|institution|universit|desired|relocat|birth|citizenship|emergency|reference|supervisor/;
  const OTHER_SECTION = /education|experience|employment|language|mobility|certification|membership|reference/;

  function classify(el, label) {
    const ac = (el.getAttribute('autocomplete') || '').split(/\s+/).pop();
    const attrs = norm(`${el.name || ''} ${el.id || ''}`.replace(/[_\-[\]]/g, ' '));
    // The visible label wins over name/id tokens ("State" inside id "countryRegion" is a state);
    // name/id only decide when the label says nothing. Both beat autocomplete (e.g. "name" fields).
    for (const hay of [norm(label), norm(`${label} ${attrs}`)]) {
      for (const [key, re, max] of RULES) {
        if (max && label.length > max) continue; // length limit applies to the visible label only
        if (!re.test(hay)) continue;
        if (PLACE_KEYS.has(key) && (OTHER_PLACE.test(label) || OTHER_SECTION.test(sectionHeading(el))
          || (homeQualified.has(key) && !HOME_QUAL.test(label)))) continue;
        return key;
      }
    }
    return AUTOCOMPLETE[ac] || null;
  }

  // Graduation date from the first education entry; `expected` picks the "(if not completed)" box.
  function gradDate(p, expected, placeholder) {
    const e = (p.education || [])[0];
    if (!e || !e.toYear) return '';
    const y = Number(e.toYear);
    const m = Number(e.toMonth || 12);
    const done = new Date(y, m - 1, 28) <= new Date();
    if (done === expected) return ''; // completed -> "Graduation Date"; not yet -> "Expected Graduation Date"
    const mm = String(m).padStart(2, '0');
    const dd = String(new Date(y, m, 0).getDate()).padStart(2, '0');
    const ph = (placeholder || '').toUpperCase();
    if (/^YYYY$/.test(ph)) return String(y);
    if (/MM\W+YYYY/.test(ph) && !/DD/.test(ph)) return `${mm}/${y}`;
    return `${mm}/${dd}/${y}`;
  }

  function valueFor(key, p) {
    switch (key) {
      case 'fullName': return [p.firstName, p.lastName].filter(Boolean).join(' ');
      case 'skills': return skillsList(p).join(', ');
      case 'languages': return (p.languages || []).filter((l) => l.language)
        .map((l) => (l.proficiency ? `${l.language} (${l.proficiency})` : l.language)).join(', ');
      case 'phoneExt': case 'secondLastName': return '';
      case 'secondaryPhone': return p.secondaryPhone || '';
      case 'graduationDate': case 'expectedGraduation': return '';
      case 'address2': return p.address2 || '';
      case 'preferredName': return p.preferredName || p.firstName || '';
      case 'degreeCompleted': { // Yes once the graduation date has passed
        const e = (p.education || [])[0];
        if (!e || !e.toYear) return '';
        return new Date(Number(e.toYear), Number(e.toMonth || 12) - 1, 28) <= new Date() ? 'Yes' : 'No';
      }
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

  const PLACEHOLDER = /^(no selection|select one|select|please select|choose( one)?|--+|—)$/;

  // Ways an option can match the answer, strictest first. Short answers ("us", "no") must match whole
  // words, so "us" can't land on "Australia".
  function tierFinders(a) {
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)');
    const real = (x) => x && !PLACEHOLDER.test(x);
    return [
      (x) => x === a,
      (x) => real(x) && x.startsWith(a) && (a.length >= 3 || !/[a-z0-9]/.test(x[a.length] || '')),
      (x) => real(x) && word.test(x),
      (x) => real(x) && a.length >= 4 && x.includes(a),
      (x) => real(x) && x.length >= 4 && a.includes(x),
    ];
  }

  function pickAny(texts, answers) {
    const t = texts.map(norm);
    const list = answers.map(norm).filter(Boolean);
    if (list[0] === 'decline') return t.findIndex((x) => DECLINE.test(x));
    const finders = list.map(tierFinders);
    for (let tier = 0; tier < 5; tier++) {
      for (const f of finders) {
        const i = t.findIndex(f[tier]);
        if (i >= 0) return i;
      }
    }
    return -1;
  }

  const pickOption = (texts, answer) => pickAny(texts, [answer]);

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
        if (no) out.unshift('I am not a protected veteran', 'not a protected veteran', 'I am not a veteran', 'not a veteran');
        if (yes) out.unshift('I identify as one or more of the classifications of protected veteran', 'identify as one or more', 'protected veteran', 'I am a veteran');
      } else {
        if (no) out.unshift('No, I do not have a disability', 'No, I do not have a disability and have not had one');
        if (yes) out.unshift('Yes, I have a disability', 'Yes, I have a disability, or have had one');
      }
    } else if (key === 'employmentType') {
      const alts = [
        [/intern/i, ['Internship', 'Intern', 'Co-op', 'Temporary']],
        [/full/i, ['Full-time', 'Full time', 'Regular', 'Permanent']],
        [/part/i, ['Part-time', 'Part time']],
        [/contract/i, ['Contract', 'Contractor', 'Temporary']],
      ];
      for (const [re, list] of alts) if (re.test(a)) { out.push(...list); break; }
    } else if (key === 'proficiency' || key === 'langProficiency') {
      const alts = [
        [/native|fluent/i, ['Fluent', 'Native', 'Expert', 'Advanced']],
        [/advanced/i, ['Advanced', 'Fluent', 'Proficient']],
        [/intermediate/i, ['Intermediate', 'Proficient', 'Conversational']],
        [/beginner/i, ['Beginner', 'Basic', 'Elementary', 'Novice']],
      ];
      for (const [re, list] of alts) if (re.test(a)) { out.push(...list); break; }
    } else if (key === 'race') {
      const alts = [
        [/american indian/i, ['American Indian/Alaskan Native', 'American Indian', 'Alaskan Native']],
        [/pacific/i, ['Native Hawaiian or Other Pacific Island', 'Native Hawaiian']],
        [/two or more/i, ['Two or more']],
      ];
      for (const [re, list] of alts) if (re.test(a)) { out.push(...list); break; }
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

  const skillsList = (p) => (Array.isArray(p.skills) ? p.skills : String(p.skills || '').split(/[,\n]/))
    .map((x) => x.trim()).filter(Boolean);

  const visibleOptions = () => [...document.querySelectorAll('[role=option], [role=listbox] li, [data-automation-id="promptOption"]')]
    .filter((o) => o.offsetParent !== null || o.getClientRects().length);

  const isEmptyChoice = (s) => !s || /^(select one|select|choose( one)?|please select|--+|—)$/i.test(s.trim());

  function setNative(el, v) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clickLike(el) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ev = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  const mark = (el) => { el.style.outline = '2px solid #22c55e'; el.style.outlineOffset = '1px'; };

  const shownValue = (el) => norm(el instanceof HTMLSelectElement ? (el.options[el.selectedIndex]?.text || '')
    : isListboxEl(el) ? txt(el) : el.value);

  // Did the widget really take the option we clicked? Stops a wrong value from silently staying.
  function tookPick(el, picked) {
    const o = norm(picked);
    const v = shownValue(el);
    if (v && !PLACEHOLDER.test(v) && (v === o || v.includes(o) || (v.length > 3 && o.includes(v)))) return true;
    const wrap = el.closest('[data-automation-id^="formField"]'); // multi-select widgets show a chip instead
    return !!wrap && [...wrap.querySelectorAll('[data-automation-id*="selectedItem" i]')].some((c) => norm(txt(c)).includes(o));
  }

  // The clickable list item for one of the answers: known option markup first, then any element that
  // appeared after opening the list and whose text is the answer.
  function findCandidate(opts, answers, before) {
    const i = pickAny(opts.map((o) => txt(o)), answers);
    if (i >= 0) return opts[i];
    for (const a of answers) {
      const hit = newResultItems(before, a, 1)[0];
      if (hit) return hit;
    }
    return null;
  }

  async function fillCombobox(el, answers) {
    const before = new Set(document.body.querySelectorAll('*'));
    el.focus();
    clickLike(el);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, altKey: true, bubbles: true }));
    await sleep(300);
    let opts = visibleOptions();
    if (!opts.length) { // open from the arrow/trigger next to the box, or with a plain ArrowDown
      const arrow = el.parentElement?.querySelector('button, [class*=arrow i], [class*=caret i], [class*=drop i], [class*=trigger i], [class*=icon i]');
      if (arrow && arrow !== el) clickLike(arrow);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true }));
      await sleep(300);
      opts = visibleOptions();
    }
    let target = findCandidate(opts, answers, before);
    // Long or paginated lists only load their first page: type to filter (results may load slowly).
    for (const typed of answers.slice(0, 3)) {
      if (target) break;
      setNative(el, typed);
      for (let t = 0; t < 2400 && !target; t += 300) {
        await sleep(300);
        target = findCandidate(visibleOptions(), answers, before);
      }
    }
    if (!target) { setNative(el, ''); el.blur(); return false; }
    const picked = txt(target);
    clickLike(target);
    await sleep(250);
    if (!tookPick(el, picked)) { setNative(el, ''); el.blur(); return false; }
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
    const picked = txt(opts[i]);
    clickLike(opts[i]);
    await sleep(200);
    return tookPick(el, picked);
  }

  // Read a custom dropdown's choices without selecting anything.
  async function peekOptions(el) {
    el.focus();
    clickLike(el);
    await sleep(300);
    const t = norm(visibleOptions().map((o) => txt(o)).join(' '));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    await sleep(150);
    return t;
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  // Wait up to `ms` for suggestions to show up.
  async function waitForOptions(ms) {
    for (let t = 0; t < ms; t += 150) {
      const opts = visibleOptions();
      if (opts.length) return opts;
      await sleep(150);
    }
    return [];
  }

  // Result items we can't recognize by markup: elements that appeared after the search and
  // whose text is the skill. Best match first (exact, then starts with, then contains).
  function newResultItems(before, skill, maxRank = 2) {
    const want = norm(skill);
    const rank = (t) => (t === want ? 0 : t.startsWith(want) ? 1 : t.includes(want) ? 2 : 9);
    return [...document.body.querySelectorAll('*')]
      .filter((n) => !before.has(n) && !n.children.length && shown(n))
      .map((n) => [n, rank(norm(txt(n)))])
      .filter(([, r]) => r <= maxRank)
      .sort((a, b) => a[1] - b[1])
      .map(([n]) => n);
  }

  async function waitForNewItems(before, skill, ms) {
    for (let t = 0; t < ms; t += 150) {
      const items = newResultItems(before, skill);
      if (items.length) return items;
      await sleep(150);
    }
    return [];
  }

  // Multi-select search boxes (Workday "Skills"): type a keyword, press Enter to run the search
  // (if suggestions don't appear by themselves), then click the matching result in the list.
  const missingSkills = [];
  async function fillSkills(el, list) {
    let added = 0;
    missingSkills.length = 0;
    for (const skill of list.slice(0, 20)) {
      el.focus();
      clickLike(el);
      setNative(el, skill);
      let target = null;
      const known = await waitForOptions(600);
      const k = pickAny(known.map((o) => txt(o)), [skill]);
      if (k >= 0) target = known[k];
      if (!target) {
        const before = new Set(document.body.querySelectorAll('*'));
        pressEnter(el);
        const opts = await waitForOptions(3000);
        const i = pickAny(opts.map((o) => txt(o)), [skill]);
        if (i >= 0) target = opts[i];
        else target = (await waitForNewItems(before, skill, 1500))[0] || null;
      }
      if (target) {
        clickLike(target);
        added++;
        await sleep(400);
      } else {
        missingSkills.push(skill);
      }
      if (el.value) setNative(el, '');
      await sleep(150);
    }
    return added > 0;
  }

  function fillSelect(el, answers) {
    const opts = [...el.options];
    let i = pickAny(opts.map((o) => o.text), answers);
    if (i < 0) i = pickAny(opts.map((o) => o.value), answers);
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

  const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'are', 'does', 'have', 'has', 'been', 'that', 'this', 'with',
    'any', 'please', 'will', 'would', 'our', 'can', 'not', 'from', 'into', 'than', 'then', 'there', 'their', 'such']);
  const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

  // Exact containment first; otherwise the closest saved question by shared words.
  function customAnswer(label, p) {
    const have = new Set(words(label));
    let best = null;
    let bestScore = 0;
    for (const qa of p.customQA || []) {
      const q = norm(qa.q);
      if (!q) continue;
      if (label.includes(q)) return qa.a;
      const qw = words(qa.q);
      if (qw.length < 3) continue;
      const shared = qw.filter((w) => have.has(w)).length;
      const score = shared / qw.length; // how much of the saved question the label repeats
      if (shared >= 3 && score > bestScore) { bestScore = score; best = qa; }
    }
    return bestScore >= 0.6 ? best.a : null;
  }

  // ---- Repeating sections: "Work Experience 1", "Education 1", … (Workday "My Experience") ----
  const KINDS = {
    work: { heading: /^work experience \d+$/, other: /^(education|language) \d+$/, list: 'workExperience', minControls: 5 },
    edu: { heading: /^education \d+$/, other: /^(work experience|language) \d+$/, list: 'education', minControls: 4 },
    lang: { heading: /^language \d+$/, other: /^(work experience|education) \d+$/, list: 'languages', minControls: 2 },
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

  function sectionFields(root, isLang) {
    const f = { months: [], years: [], prof: [] };
    const textRules = [
      ['title', /job title|^title$/], ['company', /company|employer/], ['location', /location/],
      ['description', /description|responsib/], ['school', /school|universit|college/],
      ['gpa', /gpa|overall result|grade/], ['degree', /\bdegree\b/], ['field', /field of study|major/],
    ];
    for (const el of root.querySelectorAll(CONTROLS)) {
      const type = (el.type || '').toLowerCase();
      if ((el.tagName === 'INPUT' && ['hidden', 'submit', 'button', 'file', 'radio'].includes(type)) || el.disabled) continue;
      if (type === 'checkbox') {
        const t = labelText(el);
        if (/fluent/.test(t)) f.fluent = el;
        else if (/currently|current/.test(t)) f.current = el;
        continue;
      }
      const own = norm([el.id, el.name, el.getAttribute('data-automation-id'), el.getAttribute('aria-label'), el.placeholder]
        .filter(Boolean).join(' ').replace(/[_\-[\]]/g, ' '));
      if (/month|\bmm\b/.test(own)) { f.months.push(el); continue; }
      if (/year|yyyy/.test(own)) { f.years.push(el); continue; }
      const label = labelText(el);
      if (isLang && /comprehension|overall|reading|speaking|writing/.test(label) && !/result/.test(label)) { f.prof.push(el); continue; }
      if (isLang && !f.language && /\blanguage\b/.test(`${label} ${own}`)) { f.language = el; continue; }
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

  // One "Language N" block: the language, then either "I am fluent" or each proficiency rating.
  async function fillLanguage(f, e, i, filled) {
    const done = (el, what) => { mark(el); filled.push({ label: `Language ${i + 1}: ${what}`, key: 'language' }); };
    if (f.language && e.language && (isListboxEl(f.language) || f.language instanceof HTMLSelectElement || !f.language.value)) {
      if (await setControl(f.language, e.language, 'language')) done(f.language, 'language');
    }
    const fluent = /^(fluent|native)$/i.test(e.proficiency || '');
    if (fluent && f.fluent) {
      if (!f.fluent.checked) f.fluent.click();
      done(f.fluent, 'fluent');
      return;
    }
    if (!e.proficiency) return;
    for (const el of f.prof) {
      if (el instanceof HTMLSelectElement ? el.selectedIndex > 0 : (isListboxEl(el) ? !isEmptyChoice(txt(el)) : el.value)) continue;
      if (await setControl(el, e.proficiency, 'proficiency')) done(el, 'proficiency');
    }
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
        const f = sectionFields(roots[i], name === 'lang');
        if (name === 'lang') { await fillLanguage(f, e, i, filled); continue; }
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
    scanHomeFields(collect(document, []));
    await fillSections(p, filled, covered);
    const seen = new WeakSet();
    let langRow = 0;
    let workRow = 0;
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
        if (type !== 'file' && !shown(el)) continue;
        let label = labelText(el);
        if (/^search\b/.test(label) || /^if (other|not listed)\b/.test(label)) continue;
        if (type !== 'file' && isGeneric(label)) label = (contextBefore(el) + ' ' + label).trim();
      if (/^from date\b/.test(label)) workRow++; // counted even when the row is already filled

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
        else if (isCombo && el.value && !isEmptyChoice(el.value) && !/^no selection$/i.test(el.value.trim())) continue;
      else if (!isSelect && !isCombo && el.value) continue; // never overwrite
        if (isSelect && el.selectedIndex > 0) continue;

        // Work-experience rows: the Nth "From Date" starts the Nth saved job; never fall through to the
        // generic rules (they would put your current company in every row).
        const sf = (SF_WORK.find(([, re]) => re.test(label)) || [])[0];
        if (sf) {
          const e = (p.workExperience || [])[workRow - 1];
          if (!e || (sf !== 'from' && workRow === 0)) continue;
          let v = '';
          if (sf === 'from' || sf === 'to') v = sf === 'to' && e.current ? '' : rowDate(e, sf, label);
          else v = { company: e.company, title: e.title, city: e.location, industry: e.industry, employment: e.employmentType, country: e.country }[sf] || '';
          if (!v || (!isSelect && !isListbox && !isCombo && el.value)) continue;
          const ok = sf === 'from' || sf === 'to' ? await typeFormatted(el, v) : await setControl(el, v, sf === 'employment' ? 'employmentType' : sf === 'country' ? 'country' : null);
          if (ok) { mark(el); filled.push({ label: `Job ${workRow}: ${label.slice(0, 40)}`, key: 'workRow' }); }
          else unmatched.push(`${label.slice(0, 60)} (job ${workRow}) — no option matches "${v}"`);
          continue;
        }
        let key = classify(el, label);
        if (!key && (isSelect || isCombo)) {
          const opts = isSelect ? norm([...el.options].map((o) => o.text).join(' ')) : await peekOptions(el);
          key = (RULES.find(([k, re]) => OPTION_RULES.includes(k) && re.test(opts)) || [])[0] || null;
        }
        let answer = customAnswer(label, p);
        if (answer == null && key) answer = valueFor(key, p);
      // Language Skills rows: the Nth "Language" box gets the Nth language, its ratings get that row's level.
      if (key === 'languageName') { langRow++; answer = (p.languages || [])[langRow - 1]?.language || ''; }
      else if (key === 'langProficiency') answer = (p.languages || [])[Math.max(langRow - 1, 0)]?.proficiency || '';
      else if (key === 'graduationDate' || key === 'expectedGraduation') answer = gradDate(p, key === 'expectedGraduation', el.placeholder);
      if (key === 'languages' && (isSelect || isListbox || isCombo)) answer = (p.languages || [])[0]?.language || '';
        if (!answer) {
          const quiet = ['phoneExt', 'secondLastName', 'middleName', 'secondaryPhone', 'address2', 'graduationDate', 'expectedGraduation'].includes(key) || /^if (yes|so|you)\b/.test(label);
          if (label && !quiet) unmatched.push(`${label.slice(0, 70)} — ${key ? `no "${key}" saved in your profile` : 'field not recognized'}`);
          continue;
        }
        const answers = variants(key, answer);

        const multi = key === 'skills' && (isCombo || el.getAttribute('aria-haspopup') || el.closest('[data-automation-id*="multiSelect" i]'));
        let ok = false;
        if (multi) {
        ok = await fillSkills(el, skillsList(p));
        if (missingSkills.length) unmatched.push(`skills this site doesn't list: ${missingSkills.join(', ')}`);
      }
        else if (isListbox) ok = await fillListbox(el, answers);
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

  // ---- Work-experience rows without headings (SuccessFactors profile): a row starts at "From Date" ----
  const SF_WORK = [
    ['from', /^from date\b/], ['to', /^end date\b/], ['company', /^company name\b/], ['title', /^position title\b/],
    ['city', /^company city\b/], ['industry', /^type of business\b/], ['employment', /^employment type\b/],
    ['country', /^company country\b/],
  ];

  // Types a formatted value (07/01/2026) character by character, then commits it with Enter and blur.
  async function typeFormatted(el, text) {
    el.focus();
    el.click();
    for (const ch of String(text)) {
      if (key(el, 'keydown', ch)) { key(el, 'keypress', ch); insertChar(el, ch); }
      key(el, 'keyup', ch);
      await sleep(20);
    }
    pressEnter(el);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    el.blur();
    await sleep(80);
    if (!el.value) setNative(el, String(text)); // last resort
    return true;
  }

  function rowDate(e, which, label) {
    const y = e[which + 'Year'];
    const m = e[which + 'Month'];
    if (!y || !m) return '';
    const mm = String(m).padStart(2, '0');
    if (/mm\/yyyy/.test(label) && !/dd/.test(label)) return `${mm}/${y}`;
    const dd = which === 'from' ? '01' : String(new Date(Number(y), Number(m), 0).getDate()).padStart(2, '0');
    return `${mm}/${dd}/${y}`;
  }

  // Remember answers: save what you chose on this page as reusable saved answers ----
  // Personal details live in the profile, so they are never copied into saved answers.
  const LEARN_SKIP = new Set(['email', 'phone', 'secondaryPhone', 'phoneExt', 'phoneCountryCode', 'phoneType',
    'firstName', 'middleName', 'lastName', 'secondLastName', 'fullName', 'preferredName', 'address', 'address2',
    'city', 'state', 'zip', 'country', 'linkedin', 'github', 'portfolio', 'salary', 'currentCompany', 'currentTitle',
    'school', 'degree', 'major', 'gpa', 'skills', 'languages', 'languageName', 'langProficiency', 'graduationDate',
    'expectedGraduation', 'degreeCompleted']);

  // What the field currently shows, or '' while it still holds a placeholder such as "No Selection".
  function currentAnswer(el) {
    if (el instanceof HTMLSelectElement) return el.selectedIndex > 0 ? el.options[el.selectedIndex].text.trim() : '';
    const t = (isListboxEl(el) ? txt(el) : el.value || '').trim();
    return isEmptyChoice(t) || /^no selection$/i.test(t) ? '' : t;
  }

  function skippable(el) {
    return el.closest('[role=search], nav, header, [id*=cookie i], [class*=cookie i], [id*=onetrust i], [class*=onetrust i]');
  }

  window.__jobAutofillLearn = async function () {
    const store = await window.JA_PROFILES.load();
    const profile = store.profiles[store.activeProfileId].data;
    const qa = profile.customQA || (profile.customQA = []);
    scanHomeFields(collect(document, []));
    const learned = [];
    const radios = new Map();

    const remember = (label, answer) => {
      const q = label.trim().slice(0, 160);
      if (q.length < 4 || /\b(date|month|year|mm|yyyy)\b/.test(q) || !answer || answer.length > 300) return;
      const existing = qa.find((x) => norm(x.q) === norm(q));
      if (existing) existing.a = answer; else qa.push({ q, a: answer });
      learned.push({ q, a: answer });
    };

    for (const el of collect(document, [])) {
      const isListbox = isListboxEl(el);
      const type = isListbox ? 'listbox' : (el.type || '').toLowerCase();
      if (SKIP_TYPES.has(type) || ['checkbox', 'file'].includes(type) || el.disabled || el.tagName === 'TEXTAREA') continue;
      if (type === 'radio') {
        const k = (el.name || '') + '|' + (el.form ? [...document.forms].indexOf(el.form) : '');
        if (!radios.has(k)) radios.set(k, []);
        radios.get(k).push(el);
        continue;
      }
      if (skippable(el)) continue;
      let label = labelText(el);
      if (/^search\b/.test(label)) continue;
      if (isGeneric(label)) label = (contextBefore(el) + ' ' + label).trim();
      const answer = currentAnswer(el);
      if (!answer) continue;
      const key = classify(el, label);
      if (key && (LEARN_SKIP.has(key) || valueFor(key, profile))) continue; // the profile already answers this
      remember(label, answer);
    }

    for (const group of radios.values()) {
      const picked = group.find((r) => r.checked);
      if (!picked) continue;
      const q = questionText(group);
      const key = classify(group[0], q);
      if (key && (LEARN_SKIP.has(key) || valueFor(key, profile))) continue;
      remember(q, labelText(picked) || picked.value);
    }

    await window.JA_PROFILES.save(store.profiles, store.activeProfileId);
    return learned;
  };

  // ---- Troubleshooting report: what the extension sees, without your typed text ----
  window.__jobAutofillReport = async function () {
    const p = (await window.JA_PROFILES.active()) || {};
    scanHomeFields(collect(document, []));
    const fields = [];
    for (const el of collect(document, [])) {
      const isListbox = isListboxEl(el);
      const type = isListbox ? 'listbox' : (el.type || '').toLowerCase();
      if (['hidden', 'submit', 'reset', 'image', 'password'].includes(type) || (type === 'button' && !isListbox)) continue;
      let label = labelText(el);
      if (isGeneric(label)) label = (contextBefore(el) + ' ' + label).trim();
      const key = classify(el, label);
      const typed = !isListbox && !(el instanceof HTMLSelectElement) && ['text', 'search', 'email', 'tel', 'url', 'number', ''].includes(type);
      fields.push({
        tag: el.tagName.toLowerCase(), type, role: el.getAttribute('role') || undefined,
        popup: el.getAttribute('aria-haspopup') || undefined, id: el.id || undefined,
        auto: el.getAttribute('data-automation-id') || undefined,
        cls: (el.className && String(el.className).slice(0, 60)) || undefined,
        label: label.slice(0, 120), key, profileHasValue: key ? !!valueFor(key, p) : undefined,
        shown: shown(el), disabled: el.disabled || undefined,
        current: typed ? (el.value ? `[${el.value.length} chars]` : '') : currentAnswer(el),
        options: el instanceof HTMLSelectElement ? [...el.options].slice(0, 15).map((o) => o.text.trim()) : undefined,
        heading: sectionHeading(el).slice(0, 60) || undefined,
      });
    }
    return { page: location.origin + location.pathname, topFrame: window === window.top, fields: fields.slice(0, 250) };
  };
})();

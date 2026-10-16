const out = document.getElementById('out');

const sel = document.getElementById('profile');
let store = null;
(async () => {
  store = await JA_PROFILES.load();
  for (const [id, p] of Object.entries(store.profiles)) sel.append(new Option(p.name, id));
  sel.value = store.activeProfileId;
})();
sel.onchange = () => JA_PROFILES.save(store.profiles, (store.activeProfileId = sel.value));

document.getElementById('opts').onclick = () => chrome.runtime.openOptionsPage();

document.getElementById('fill').onclick = async () => {
  out.className = '';
  out.textContent = 'Filling…';
  try {
    const profile = await JA_PROFILES.active();
    if (!profile || !profile.email) {
      out.textContent = 'Set up your profile first.';
      out.className = 'warn';
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const target = { tabId: tab.id, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ['data.js', 'profiles.js', 'content.js'] });
    const results = await chrome.scripting.executeScript({ target, func: () => window.__jobAutofill() });

    const filled = [];
    const unmatched = new Set();
    for (const r of results) {
      if (!r.result) continue;
      filled.push(...r.result.filled);
      r.result.unmatched.forEach((u) => unmatched.add(u));
    }
    render(filled, [...unmatched]);
  } catch (e) {
    out.textContent = '';
    const msg = document.createElement('span');
    msg.className = 'warn';
    msg.textContent = 'Could not fill this page: ' + String(e.message || e);
    out.append(msg);
  }
};

function render(filled, unmatched) {
  out.textContent = '';
  const add = (title, items, cls) => {
    if (!items.length) return;
    const h = document.createElement('h4'); h.textContent = title; out.append(h);
    const ul = document.createElement('ul'); if (cls) ul.className = cls;
    items.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.append(li); });
    out.append(ul);
  };
  add(`Filled (${filled.length})`, filled.map((f) => f.label || f.key));
  add('Needs your attention', unmatched, 'warn');
  if (!filled.length && !unmatched.length) out.textContent = 'No form fields found on this page.';
  else out.append(Object.assign(document.createElement('p'), { textContent: 'Review everything, then submit yourself.' }));
}

// Run a function in every frame of the current tab and return the non-empty results.
async function inPage(func) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const target = { tabId: tab.id, allFrames: true };
  await chrome.scripting.executeScript({ target, files: ['data.js', 'profiles.js', 'content.js'] });
  const results = await chrome.scripting.executeScript({ target, func });
  return results.map((r) => r.result).filter(Boolean);
}

document.getElementById('learn').onclick = async () => {
  out.className = '';
  out.textContent = 'Reading your answers…';
  try {
    const learned = (await inPage(() => window.__jobAutofillLearn())).flat();
    out.textContent = '';
    const h = document.createElement('h4');
    h.textContent = learned.length ? `Remembered (${learned.length})` : 'Nothing new to remember';
    out.append(h);
    if (learned.length) {
      const ul = document.createElement('ul');
      learned.forEach((x) => { const li = document.createElement('li'); li.textContent = `${x.q.slice(0, 60)} → ${x.a.slice(0, 40)}`; ul.append(li); });
      out.append(ul, Object.assign(document.createElement('p'), { textContent: 'Saved to this profile. Edit them under Edit profile → Saved answers.' }));
    } else {
      out.append(Object.assign(document.createElement('p'), { textContent: 'Answer the questions on the page first, then click this. Details like your name and address are kept in your profile, not here.' }));
    }
  } catch (e) {
    out.className = 'warn';
    out.textContent = 'Could not read this page: ' + String(e.message || e);
  }
};

document.getElementById('report').onclick = async () => {
  out.className = '';
  try {
    const text = JSON.stringify(await inPage(() => window.__jobAutofillReport()), null, 1);
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    out.textContent = `Copied a field report (${Math.round(text.length / 1024)} KB). Paste it where you are asking for help. It has no typed text.`;
  } catch (e) {
    out.className = 'warn';
    out.textContent = 'Could not build the report: ' + String(e.message || e);
  }
};

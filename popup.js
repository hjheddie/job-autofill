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

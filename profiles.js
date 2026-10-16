// Multi-profile storage shared by the popup, options page and content script.
// Layout in chrome.storage.local: { profiles: { [id]: { name, data } }, activeProfileId }
(function (g) {
  const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  async function load() {
    const s = await chrome.storage.local.get(['profiles', 'activeProfileId', 'profile']);
    let { profiles, activeProfileId } = s;
    if (!profiles || !Object.keys(profiles).length) {
      // First run, or upgrade from the single-profile layout (`profile` key).
      const id = uid();
      profiles = { [id]: { name: 'Default', data: s.profile || {} } };
      activeProfileId = id;
      await chrome.storage.local.set({ profiles, activeProfileId });
      await chrome.storage.local.remove('profile');
    } else if (!profiles[activeProfileId]) {
      activeProfileId = Object.keys(profiles)[0];
    }
    return { profiles, activeProfileId };
  }

  const save = (profiles, activeProfileId) => chrome.storage.local.set({ profiles, activeProfileId });

  async function active() {
    const { profiles, activeProfileId } = await load();
    return profiles[activeProfileId].data;
  }

  g.JA_PROFILES = { uid, load, save, active };
})(typeof window !== 'undefined' ? window : globalThis);

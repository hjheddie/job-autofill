// Multi-profile storage shared by the popup, options page and content script.
// chrome.storage.local: { profiles: { [id]: { name, data } }, activeProfileId,
//                         sharedGroups: { [group]: boolean }, sharedData: { ...values of the shared groups } }
// A group of settings is either "shared" (one copy used by every profile) or kept per profile.
(function (g) {
  const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Every setting belongs to one group; `shared` is the default for a new install.
  const GROUPS = {
    contact: { title: 'Contact', shared: true, keys: ['firstName', 'middleName', 'lastName', 'email', 'phone', 'address', 'city', 'state', 'zip', 'country'] },
    links: { title: 'Links', shared: true, keys: ['linkedin', 'github', 'portfolio'] },
    jobPrefs: { title: 'Job preferences', shared: false, keys: ['salary', 'availableDate'] },
    answers: { title: 'Standard answers', shared: true, keys: ['over18', 'restrictive', 'previousEmployee', 'referral', 'relatedEmployee'] },
    workAuth: { title: 'Work authorization', shared: true, keys: ['workAuth', 'sponsorship'] },
    selfId: { title: 'Voluntary self-identification', shared: true, keys: ['furnish', 'gender', 'race', 'hispanic', 'veteran', 'disability'] },
    workExperience: { title: 'Work experience', shared: false, keys: ['workExperience'] },
    education: { title: 'Education', shared: true, keys: ['education'] },
    languages: { title: 'Languages', shared: true, keys: ['languages'] },
    resume: { title: 'Resume', shared: false, keys: ['resume'] },
    skills: { title: 'Skills', shared: false, keys: ['skills'] },
    employers: { title: 'Employers', shared: true, keys: ['pastEmployers', 'relativeEmployers'] },
    savedAnswers: { title: 'Saved answers', shared: true, keys: ['customQA'] },
  };
  const GROUP_OF = {};
  for (const [id, d] of Object.entries(GROUPS)) for (const k of d.keys) GROUP_OF[k] = id;

  const defaultGroups = () => Object.fromEntries(Object.entries(GROUPS).map(([id, d]) => [id, d.shared]));
  const filled = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length);
  const sharedKeys = (groups) => Object.keys(GROUP_OF).filter((k) => groups[GROUP_OF[k]]);

  // The settings the extension uses for a profile: its own values, with the shared groups' values on top.
  function merge(data, shared) {
    const out = { ...data };
    for (const k of sharedKeys(shared.groups)) {
      if (shared.data[k] !== undefined) out[k] = shared.data[k]; else delete out[k];
    }
    return out;
  }

  // Splits a flat set of values into what is stored per profile and what is stored once.
  function split(flat, shared) {
    const profileData = {}, sharedData = {};
    for (const [k, v] of Object.entries(flat)) {
      if (GROUP_OF[k] && shared.groups[GROUP_OF[k]]) sharedData[k] = v; else profileData[k] = v;
    }
    return { profileData, sharedData };
  }

  async function load() {
    const s = await chrome.storage.local.get(['profiles', 'activeProfileId', 'profile', 'sharedGroups', 'sharedData']);
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
    let groups = s.sharedGroups, data = s.sharedData;
    if (!groups) {
      // Upgrade: the shared groups start from what the profiles already hold (active profile first),
      // so nothing has to be typed again. Other profiles' differing values stay stored but unused.
      groups = defaultGroups();
      data = {};
      const order = [activeProfileId, ...Object.keys(profiles).filter((id) => id !== activeProfileId)];
      for (const k of sharedKeys(groups)) {
        for (const id of order) {
          const v = profiles[id].data[k];
          if (filled(v)) { data[k] = v; break; }
        }
      }
      await chrome.storage.local.set({ sharedGroups: groups, sharedData: data });
    } else {
      groups = { ...defaultGroups(), ...groups }; // groups added by a newer version
    }
    return { profiles, activeProfileId, shared: { groups, data: data || {} } };
  }

  // `shared` ({ groups, data }) is only written when passed.
  const save = (profiles, activeProfileId, shared) => chrome.storage.local.set({
    profiles, activeProfileId, ...(shared ? { sharedGroups: shared.groups, sharedData: shared.data } : {}),
  });

  async function active() {
    const s = await load();
    return merge(s.profiles[s.activeProfileId].data, s.shared);
  }

  // Stores changed values for the active profile, each in the right place (shared or per profile).
  async function saveKeys(patch) {
    const s = await load();
    const { profileData, sharedData } = split(patch, s.shared);
    Object.assign(s.profiles[s.activeProfileId].data, profileData);
    Object.assign(s.shared.data, sharedData);
    await save(s.profiles, s.activeProfileId, s.shared);
  }

  g.JA_PROFILES = { uid, load, save, active, saveKeys, merge, split, GROUPS, GROUP_OF, sharedKeys };
})(typeof window !== 'undefined' ? window : globalThis);

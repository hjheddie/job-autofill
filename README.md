# Job Autofill (MVP)

Manifest V3 extension that fills job application forms from a locally stored profile.
It never submits, never touches CAPTCHAs, and sends nothing off the machine.

## Install (Chrome / Edge)
Keep the folder somewhere permanent: Chrome loads an unpacked extension directly from its folder, so moving or deleting it breaks the extension (`ERR_FILE_NOT_FOUND`).

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** and pick this folder.
3. Click the extension icon, then **Edit profile**, fill it in, upload a resume, and **Save**.
4. On an application page click the icon, then **Fill this page**. Review and submit yourself.

## How it works
- `content.js` is injected on click (`activeTab`, all frames) so it also reaches iframe-embedded forms (Greenhouse, Lever).
- Fields are identified from label text, `aria-*`, name/id and `autocomplete`, matched against `RULES`, then filled using the native value setter and dispatched events so React/Vue forms register the value.
- Handles text, textarea, select, radio groups, react-select style comboboxes, and resume upload.
- Fields that already have a value are never overwritten. Fields it could not answer are listed in the popup.
- "Saved answers" in the profile match any label containing the question text.

## Multiple profiles
Create, duplicate, rename and delete profiles on the options page (e.g. one per role type). The popup has a profile picker; the selected profile is the one that gets filled. An existing single profile is migrated automatically to "Default".

## Skills
Add skills (comma or line separated) to a profile. Plain "Skills" text boxes get them as a comma-separated list; search-and-pick boxes (Workday) get each skill typed and the matching suggestion chosen. Skills the site doesn't offer are listed under "Needs your attention".

## Work experience and education
Saved in the profile as repeatable blocks. On pages with "Work Experience N" / "Education N" headings (Workday "My Experience") the filler matches entries to blocks in order, clicks **Add Another** when the page has fewer blocks than you have entries, fills dates as MM / YYYY, ticks "I currently work here", and maps degree to the closest dropdown option.

## Not yet done
- Workday: the "Websites" list, and page-by-page re-fill is manual (click Fill on each step).
- Date pickers, checkboxes, multi-step "re-fill on next page".
- Per-ATS adapters, resume parsing, optional LLM answers.

## Test
`test/form.html` is a Greenhouse-style fixture. Open it, inject `content.js`, and call `__jobAutofill(profile)`.

## Privacy and security
- Profiles and resumes are stored unencrypted in `chrome.storage.local` on your machine; anyone with access to your browser profile can read them. They are never sent anywhere by this extension.
- The extension runs only when you click **Fill this page** (`activeTab`) and has no network access or remote code.
- Filled values are visible to the page you fill, as with any autofill. Only use it on sites you trust.
- Do not commit exported profiles or resumes (`.gitignore` blocks common names).

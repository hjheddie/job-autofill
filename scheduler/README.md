# Illini Scheduler

A schedule builder for UIUC with the features College Scheduler's Breaks page lacks.

```
npm start      # http://localhost:3000  (Node 18+, no dependencies)
npm test       # engine tests against live data; needs the server running
```

## What it does
- Pulls sections from the public Course Explorer API for any term (default Spring 2027).
- **Breaks:** paint a weekly grid. Red = never schedule here, yellow = avoid if possible.
- **Preferences:** earliest/latest class, min/max gap, max back-to-back hours, days off,
  walking time between buildings (geocoded from OpenStreetMap), minimum RMP rating.
- **Ranking:** weighted by Rate My Professors rating, average GPA (UIUC grade dataset, last 5
  years), easier courses (RMP difficulty and share of A grades), preferred-free times, gaps,
  days on campus, and an early/late preference.
- **Lock a section** so every schedule uses it, and **link** lectures to the discussions or
  labs that go with them (Course Explorer does not publish that pairing).
- **Guided search** (best sections first, then hill-climbing from the best results and random
  starts) runs in a web worker, and collapses interchangeable duplicates.
- **Swaps & backups:** for each section, the best replacements if it fills, with score change.
- **Compare** saved schedules side by side, **map** each day's walks (Leaflet + OpenStreetMap),
  **share** a plan by link, **backup/restore** everything as a JSON file.
- **Browse courses** by gen-ed, level, credits and subject (needs a built index, see below).
- **Prerequisite check** against the courses you say you have taken (heuristic text parsing).
- **Registration day** page: CRNs with copy buttons, backups, a countdown, tick-off list, print.

## Course index for Browse
`npm run build-index -- 2027/spring` writes `public/data/index_2027_spring.json`
(one request per subject). Rebuild it when the term's offerings change.

## Limits
- It cannot register you; use the CRNs in Self-Service.
- No live seat counts: Course Explorer does not publish open/closed status, and Banner
  needs a login. Use "exclude" on a section you know is full, or the swaps panel.
- No final-exam conflict warnings: the exam schedule is not in Course Explorer.
- Lecture-to-discussion pairing is manual (Link…); the app cannot infer it.
- Prerequisite checking reads catalog prose; "and/or" structure and non-course requirements
  (standing, consent) are approximated. Treat it as a warning, not an audit.
- Saved schedules live in your browser; use Share link or Backup to move them between devices.
- Future terms often have no instructors yet; those sections use course-level GPA and a neutral RMP.
- RMP uses its unofficial public endpoint; it may change without notice. Personal use only.
- Data is cached in `.cache/` (or `/tmp` on Vercel); GPA data is the snapshot in `data/gpa.json`
  (`npm run build-data` refreshes it).

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
- **Ranking:** weighted by Rate My Professors rating, average GPA (UIUC grade dataset,
  last 5 years), preferred-free times, gaps, days on campus, and early/late preference.
- Include/exclude individual sections, mark a component (lab, discussion) as not needed.
- Save schedules, export `.ics`, copy CRNs for registration.

## Limits
- It cannot register you; use the CRNs in Self-Service.
- Course Explorer has no live seat counts and no section linking rules (which lecture pairs
  with which discussion), so check restrictions in the section notes.
- Future terms often have no instructors yet; those sections use course-level GPA and a neutral RMP.
- RMP uses its unofficial public endpoint; it may change without notice. Personal use only.
- Data is cached in `.cache/`.

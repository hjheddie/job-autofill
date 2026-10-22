// Builds public/data/index_<year>_<season>.json: every course in a term (title, credits, gen-eds,
// prerequisites) for the Browse tab. Usage: node scripts/build-index.mjs 2027/spring
import fsp from 'node:fs/promises';
import { parseCascade } from '../lib.js';

const term = process.argv[2] || '2027/spring';
const CIS = `https://courses.illinois.edu/cisapp/explorer/schedule/${term}`;
const get = async (url, tries = 3) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.text();
    } catch {}
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw new Error(`failed: ${url}`);
};

const termXml = await get(`${CIS}.xml`);
const subjects = [...termXml.slice(termXml.indexOf('<subjects>')).matchAll(/<subject id="([^"]+)"[^>]*>([^<]*)<\/subject>/g)]
  .map((m) => ({ id: m[1], label: m[2].replace(/&amp;/g, '&') }));
console.log(`${subjects.length} subjects`);

const courses = [];
const queue = subjects.slice();
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const s = queue.shift();
    try {
      courses.push(...parseCascade(await get(`${CIS}/${s.id}.xml?mode=cascade`), s.id));
    } catch (err) {
      console.warn(`skipped ${s.id}: ${err.message}`);
    }
  }
}));
courses.sort((a, b) => (a.subject + a.number).localeCompare(b.subject + b.number));

const file = new URL(`../public/data/index_${term.replace('/', '_')}.json`, import.meta.url);
await fsp.mkdir(new URL('./', file), { recursive: true });
await fsp.writeFile(file, JSON.stringify({ term, built: new Date().toISOString().slice(0, 10), subjects, courses }));
console.log(`wrote ${courses.length} courses`);

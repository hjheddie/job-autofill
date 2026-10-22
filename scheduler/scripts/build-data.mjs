// Snapshots the UIUC GPA dataset into data/gpa.json so deployments don't download 8 MB per cold start.
import fsp from 'node:fs/promises';
import { buildGpaIndex, serializeGpa } from '../lib.js';

const URL_ = 'https://raw.githubusercontent.com/wadefagen/datasets/main/gpa/uiuc-gpa-dataset.csv';
const text = await (await fetch(URL_)).text();
await fsp.mkdir(new URL('../data/', import.meta.url), { recursive: true });
await fsp.writeFile(new URL('../data/gpa.json', import.meta.url), JSON.stringify(serializeGpa(buildGpaIndex(text))));
console.log('wrote data/gpa.json');

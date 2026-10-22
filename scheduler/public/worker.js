// Runs the schedule search off the UI thread.
import { generate } from './engine.js';

self.onmessage = (e) => {
  const { id, courses, prefs, grid, geo, opts } = e.data;
  self.postMessage({ id, result: generate(courses, prefs, grid, geo, opts) });
};

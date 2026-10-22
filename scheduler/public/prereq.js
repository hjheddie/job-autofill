// Heuristic prerequisite checking from catalog text such as
// "CS 126 or CS 128 or ECE 220; One of CS 173, MATH 213 and MATH 220".
// Semicolons and "and" separate requirements; every course code inside one is an alternative.
// Anything without a course code (standing, consent, test scores) is listed as "other".

const CODE = /\b([A-Z]{2,5})\s?(\d{3})\b/g;

export function normCodes(text) {
  return [...String(text || '').toUpperCase().matchAll(CODE)].map((m) => `${m[1]} ${m[2]}`);
}

export function parsePrereq(text) {
  const groups = [];
  const other = [];
  for (const part of String(text || '').split(';')) {
    for (const piece of part.split(/\s+and\s+/i)) {
      const alts = [...new Set([...piece.matchAll(CODE)].map((m) => `${m[1]} ${m[2]}`))];
      if (alts.length) groups.push(alts);
      else if (piece.trim()) other.push(piece.trim());
    }
  }
  return { groups, other };
}

// taken: Set of "CS 124" strings. Returns the requirements not yet satisfied.
export function checkPrereq(text, taken) {
  const { groups, other } = parsePrereq(text);
  const unmet = groups.filter((alts) => !alts.some((c) => taken.has(c)));
  return { unmet, other, ok: !unmet.length };
}

import { bad, parseDay } from './util.js';

export const SEARCH_FIELDS = ['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key'];
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];

/** Split the query into whitespace-separated tokens; quoted sections stay intact. */
function tokenize(q) {
  const out = [];
  let i = 0;
  while (i < q.length) {
    if (/\s/.test(q[i])) {
      i++;
      continue;
    }
    let raw = '';
    while (i < q.length && !/\s/.test(q[i])) {
      if (q[i] === '"') {
        const end = q.indexOf('"', i + 1);
        if (end < 0) throw bad('Unterminated quote in search query');
        raw += q.slice(i, end + 1);
        i = end + 1;
      } else {
        raw += q[i];
        i++;
      }
    }
    out.push(raw);
  }
  return out;
}

const unquote = (s) => {
  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"') || s.slice(1, -1).includes('"')) throw bad('Malformed quoted value');
    return s.slice(1, -1);
  }
  if (s.includes('"')) throw bad('Malformed quoted value');
  return s;
};

function parseToken(raw) {
  let neg = false;
  let s = raw;
  if (s.startsWith('-')) {
    neg = true;
    s = s.slice(1);
    if (!s) throw bad('Dangling negation in search query');
  }
  const m = /^([A-Za-z]+):(.*)$/.exec(s);
  if (!m || s.startsWith('"')) {
    const text = unquote(s);
    if (!text) throw bad('Empty search term');
    return { neg, kind: 'text', text: text.toLowerCase() };
  }
  const field = m[1].toLowerCase();
  if (!SEARCH_FIELDS.includes(field)) throw bad(`Unknown search field "${field}"`);
  const value = unquote(m[2]);
  if (!value) throw bad(`Empty value for ${field}`);
  switch (field) {
    case 'type':
      if (!TYPES.includes(value.toLowerCase())) throw bad('Invalid type');
      return { neg, kind: 'field', field, value: value.toLowerCase() };
    case 'priority':
      if (!PRIORITIES.includes(value.toLowerCase())) throw bad('Invalid priority');
      return { neg, kind: 'field', field, value: value.toLowerCase() };
    case 'is':
      if (!['open', 'resolved'].includes(value.toLowerCase())) throw bad('is: must be open or resolved');
      return { neg, kind: 'field', field, value: value.toLowerCase() };
    case 'due': {
      const d = /^(<|>)?(.+)$/.exec(value);
      const day = parseDay(d[2]);
      if (!day) throw bad('due: must be a YYYY-MM-DD date');
      return { neg, kind: 'field', field, op: d[1] || '=', value: day };
    }
    case 'points': {
      const p = /^(<=|>=|<|>|=)?(\d+(\.\d+)?)$/.exec(value);
      if (!p) throw bad('points: must be a number with optional comparison');
      return { neg, kind: 'field', field, op: p[1] || '=', value: Number(p[2]) };
    }
    case 'key':
      if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(value)) throw bad('key: must look like ABC-12');
      return { neg, kind: 'field', field, value: value.toUpperCase() };
    default:
      return { neg, kind: 'field', field, value };
  }
}

/** Parses a search query into a list of terms. Throws ApiError(400) when malformed. */
export function parseQuery(q) {
  if (typeof q !== 'string') throw bad('q must be a string');
  return tokenize(q).map(parseToken);
}

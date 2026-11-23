import { bad } from './errors.js';
import { TYPES, PRIORITIES } from './constants.js';
import { validDate } from './util.js';

const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
const isSpace = (ch) => /\s/.test(ch);

// Splits the query into terms. Quoted segments are unquoted; a term that starts with a quote is a phrase.
function tokenize(q) {
  const out = [];
  let i = 0;
  while (i < q.length) {
    while (i < q.length && isSpace(q[i])) i++;
    if (i >= q.length) break;
    let neg = false;
    if (q[i] === '-' && i + 1 < q.length && !isSpace(q[i + 1])) { neg = true; i++; }
    let text = '';
    let phrase = false;
    let first = true;
    while (i < q.length && !isSpace(q[i])) {
      if (q[i] === '"') {
        if (first) phrase = true;
        const end = q.indexOf('"', i + 1);
        if (end < 0) throw bad('Unterminated quote in search query');
        text += q.slice(i + 1, end);
        i = end + 1;
      } else {
        text += q[i];
        i++;
      }
      first = false;
    }
    out.push({ neg, text, phrase });
  }
  return out;
}

const cmp = (op, a, b) => {
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: return a === b;
  }
};

function fieldPredicate(field, v) {
  const lower = v.toLowerCase();
  if (v === '') throw bad(`Empty value for "${field}:"`);
  switch (field) {
    case 'status':
      return (i) => i.status.toLowerCase() === lower;
    case 'type':
      if (!TYPES.includes(v)) throw bad(`Invalid type "${v}"`);
      return (i) => i.type === v;
    case 'priority':
      if (!PRIORITIES.includes(v)) throw bad(`Invalid priority "${v}"`);
      return (i) => i.priority === v;
    case 'assignee':
      if (lower === 'me') return (i, env) => i.assigneeId != null && i.assigneeId === env.actor.id;
      if (lower === 'none') return (i) => i.assigneeId == null;
      return (i, env) => { const u = env.userByName(v); return !!u && i.assigneeId === u.id; };
    case 'label':
      return (i) => i.labels.some((l) => l.toLowerCase() === lower);
    case 'sprint':
      if (lower === 'active') {
        return (i, env) => { const s = i.sprintId && env.sprintById(i.sprintId); return !!s && s.state === 'active'; };
      }
      if (lower === 'none') return (i) => i.sprintId == null;
      return (i) => i.sprintId === v;
    case 'is':
      if (lower === 'open') return (i, env) => env.catOf(i) !== 'completed';
      if (lower === 'resolved') return (i, env) => env.catOf(i) === 'completed';
      throw bad('is: must be "open" or "resolved"');
    case 'due': {
      const m = /^(<|>)?(\d{4}-\d{2}-\d{2})$/.exec(v);
      if (!m || !validDate(m[2])) throw bad(`Invalid due date "${v}"`);
      const op = m[1] || '=';
      const d = m[2];
      return (i) => i.dueDate != null && cmp(op, i.dueDate, d);
    }
    case 'points': {
      const m = /^(<=|>=|<|>|=)?(\d+(?:\.\d+)?)$/.exec(v);
      if (!m) throw bad(`Invalid points "${v}"`);
      const op = m[1] || '=';
      const n = Number(m[2]);
      return (i) => i.storyPoints != null && cmp(op, i.storyPoints, n);
    }
    case 'key': {
      if (!/^[A-Za-z]+-\d+$/.test(v)) throw bad(`Invalid key "${v}"`);
      const k = v.toUpperCase();
      return (i) => i.key === k;
    }
    default:
      throw bad(`Unknown field "${field}"`);
  }
}

function compileTerm(t) {
  let pred;
  const m = t.phrase ? null : /^([A-Za-z]+):(.*)$/.exec(t.text);
  if (m) {
    const field = m[1].toLowerCase();
    if (!FIELDS.has(field)) throw bad(`Unknown field "${m[1]}"`);
    pred = fieldPredicate(field, m[2].trim());
  } else {
    const needle = t.text.toLowerCase();
    if (!needle.trim()) throw bad('Empty search term');
    pred = (i) => (i.title + '\n' + (i.description || '')).toLowerCase().includes(needle);
  }
  return t.neg ? (i, env) => !pred(i, env) : pred;
}

// Returns (issue, env) => boolean. env: { actor, userByName, sprintById, catOf }.
export function compileQuery(q) {
  const preds = tokenize(q || '').map(compileTerm);
  return (issue, env) => preds.every((p) => p(issue, env));
}

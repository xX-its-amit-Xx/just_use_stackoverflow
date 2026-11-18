import { bad } from './util.js';

const KEYS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const ws = (c) => /\s/.test(c);

// Parses the search language into AND-ed clauses. Throws 400 on malformed input.
export function parseQuery(q) {
  const clauses = [];
  const s = String(q ?? '');
  const n = s.length;
  let i = 0;
  const readQuoted = () => {
    const end = s.indexOf('"', i + 1);
    if (end < 0) throw bad('unterminated quoted string in query');
    const v = s.slice(i + 1, end);
    i = end + 1;
    return v;
  };
  while (i < n) {
    if (ws(s[i])) { i++; continue; }
    let neg = false;
    if (s[i] === '-') {
      neg = true;
      i++;
      if (i >= n || ws(s[i])) throw bad('dangling negation in query');
    }
    if (s[i] === '"') {
      const v = readQuoted();
      if (!v.trim()) throw bad('empty phrase in query');
      clauses.push({ neg, kind: 'text', value: v.toLowerCase() });
      continue;
    }
    const start = i;
    while (i < n && !ws(s[i]) && s[i] !== ':') i++;
    const word = s.slice(start, i);
    if (i < n && s[i] === ':') {
      i++;
      const key = word.toLowerCase();
      if (!KEYS.has(key)) throw bad(`unknown search field: ${word}`);
      let val;
      if (s[i] === '"') {
        val = readQuoted();
      } else {
        const vs = i;
        while (i < n && !ws(s[i])) i++;
        val = s.slice(vs, i);
      }
      if (!val) throw bad(`empty value for ${key}`);
      clauses.push({ neg, kind: key, ...parseValue(key, val) });
      continue;
    }
    if (!word) throw bad('malformed query');
    clauses.push({ neg, kind: 'text', value: word.toLowerCase() });
  }
  return clauses;
}

function parseValue(key, val) {
  const v = val.toLowerCase();
  switch (key) {
    case 'type':
      if (!TYPES.includes(v)) throw bad(`invalid type: ${val}`);
      return { value: v };
    case 'priority':
      if (!PRIORITIES.includes(v)) throw bad(`invalid priority: ${val}`);
      return { value: v };
    case 'is':
      if (v !== 'open' && v !== 'resolved') throw bad(`invalid is: value ${val}`);
      return { value: v };
    case 'due': {
      const m = /^(<|>)?(\d{4}-\d{2}-\d{2})$/.exec(val);
      if (!m || Number.isNaN(Date.parse(`${m[2]}T00:00:00Z`))) throw bad(`invalid due date: ${val}`);
      return { op: m[1] || '=', value: m[2] };
    }
    case 'points': {
      const m = /^(<=|>=|<|>)?(\d+(?:\.\d+)?)$/.exec(val);
      if (!m) throw bad(`invalid points: ${val}`);
      return { op: m[1] || '=', value: Number(m[2]) };
    }
    default:
      return { value: val };
  }
}

const cmp = (op, a, b) => {
  switch (op) {
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    default: return a === b;
  }
};

function predicate(c, ctx) {
  const v = typeof c.value === 'string' ? c.value.toLowerCase() : c.value;
  switch (c.kind) {
    case 'text':
      return (i) => i.title.toLowerCase().includes(v) || (i.description || '').toLowerCase().includes(v);
    case 'status':
      return (i) => i.status.toLowerCase() === v;
    case 'type':
      return (i) => i.type === v;
    case 'priority':
      return (i) => i.priority === v;
    case 'assignee': {
      if (v === 'none') return (i) => !i.assigneeId;
      if (v === 'me') return (i) => !!i.assigneeId && i.assigneeId === ctx.meId;
      const u = ctx.userByName(v);
      return (i) => !!u && i.assigneeId === u.id;
    }
    case 'label':
      return (i) => i.labels.some((l) => l.toLowerCase() === v);
    case 'sprint': {
      if (v === 'none') return (i) => !i.sprintId;
      if (v === 'active') return (i) => !!i.sprintId && ctx.activeSprintOf(i.projectId) === i.sprintId;
      return (i) => i.sprintId === c.value;
    }
    case 'is':
      return v === 'open' ? (i) => !i.resolvedAt : (i) => !!i.resolvedAt;
    case 'due':
      return (i) => !!i.dueDate && cmp(c.op, i.dueDate, c.value);
    case 'points':
      return (i) => i.storyPoints != null && cmp(c.op, i.storyPoints, c.value);
    case 'key':
      return (i) => i.key.toLowerCase() === v;
    default:
      return () => false;
  }
}

// ctx: { meId, userByName(name), activeSprintOf(projectId) }
export function buildMatcher(clauses, ctx) {
  const preds = clauses.map((c) => {
    const p = predicate(c, ctx);
    return c.neg ? (i) => !p(i) : p;
  });
  return (issue) => preds.every((p) => p(issue));
}

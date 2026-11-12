// Query language for GET /api/search.
// Terms are ANDed. Supported: status:"In Progress", type:, priority:, assignee:me|<username>|none,
// label:, sprint:active|<id>|none, is:open|resolved, due:[<>]YYYY-MM-DD, points:[<>=]N, key:ABC-12,
// free text, "quoted phrases", and a leading '-' to negate any term.

export class QueryError extends Error {}

const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const QUALIFIERS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);

const isSpace = (c) => /\s/.test(c);

function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseQualifier(name, value) {
  switch (name) {
    case 'status':
    case 'assignee':
    case 'label':
    case 'sprint':
      return { v: value };
    case 'type':
      if (!TYPES.includes(value)) throw new QueryError(`invalid type "${value}"`);
      return { v: value };
    case 'priority':
      if (!PRIORITIES.includes(value)) throw new QueryError(`invalid priority "${value}"`);
      return { v: value };
    case 'is':
      if (value !== 'open' && value !== 'resolved') throw new QueryError(`invalid is:"${value}"`);
      return { v: value };
    case 'due': {
      const m = /^(<|>)?(\d{4}-\d{2}-\d{2})$/.exec(value);
      if (!m || !isDate(m[2])) throw new QueryError(`invalid due date "${value}"`);
      return { op: m[1] || '=', v: m[2] };
    }
    case 'points': {
      const m = /^(<=|>=|<|>)?(\d+(?:\.\d+)?)$/.exec(value);
      if (!m) throw new QueryError(`invalid points "${value}"`);
      return { op: m[1] || '=', v: Number(m[2]) };
    }
    case 'key': {
      if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(value)) throw new QueryError(`invalid key "${value}"`);
      return { v: value.toUpperCase() };
    }
    default:
      throw new QueryError(`unknown qualifier "${name}"`);
  }
}

export function parseQuery(q) {
  const s = String(q ?? '');
  const terms = [];
  let i = 0;
  while (i < s.length) {
    if (isSpace(s[i])) {
      i++;
      continue;
    }
    let neg = false;
    if (s[i] === '-') {
      neg = true;
      i++;
      if (i >= s.length || isSpace(s[i])) throw new QueryError('dangling "-"');
    }
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) throw new QueryError('unterminated quoted phrase');
      const text = s.slice(i + 1, end).trim();
      if (!text) throw new QueryError('empty quoted phrase');
      terms.push({ kind: 'text', value: text.toLowerCase(), neg });
      i = end + 1;
      continue;
    }
    const m = /^([A-Za-z]+):/.exec(s.slice(i));
    if (m) {
      const name = m[1].toLowerCase();
      if (!QUALIFIERS.has(name)) throw new QueryError(`unknown qualifier "${m[1]}"`);
      i += m[0].length;
      let value;
      if (s[i] === '"') {
        const end = s.indexOf('"', i + 1);
        if (end < 0) throw new QueryError('unterminated quoted value');
        value = s.slice(i + 1, end);
        i = end + 1;
      } else {
        let j = i;
        while (j < s.length && !isSpace(s[j])) j++;
        value = s.slice(i, j);
        i = j;
      }
      if (!value) throw new QueryError(`empty value for "${name}"`);
      terms.push({ kind: 'field', name, neg, ...parseQualifier(name, value) });
      continue;
    }
    let j = i;
    while (j < s.length && !isSpace(s[j])) j++;
    terms.push({ kind: 'text', value: s.slice(i, j).toLowerCase(), neg });
    i = j;
  }
  return terms;
}

const lc = (x) => String(x ?? '').toLowerCase();

function testTerm(t, v) {
  if (t.kind === 'text') {
    return lc(v.title).includes(t.value) || lc(v.description).includes(t.value);
  }
  switch (t.name) {
    case 'status':
      return lc(v.status) === lc(t.v);
    case 'type':
      return v.type === t.v;
    case 'priority':
      return v.priority === t.v;
    case 'assignee':
      if (t.v === 'me') return v.assigneeId != null && v.assigneeId === v.meId;
      if (t.v === 'none') return !v.assigneeId;
      return !!v.assigneeUsername && lc(v.assigneeUsername) === lc(t.v);
    case 'label':
      return (v.labels || []).some((l) => lc(l) === lc(t.v));
    case 'sprint':
      if (t.v === 'active') return v.sprintState === 'active';
      if (t.v === 'none') return !v.sprintId;
      return v.sprintId === t.v;
    case 'is':
      return t.v === 'open' ? v.category !== 'completed' : v.category === 'completed';
    case 'due': {
      if (!v.dueDate) return false;
      if (t.op === '<') return v.dueDate < t.v;
      if (t.op === '>') return v.dueDate > t.v;
      return v.dueDate === t.v;
    }
    case 'points': {
      if (v.storyPoints == null) return false;
      const p = v.storyPoints;
      switch (t.op) {
        case '<': return p < t.v;
        case '>': return p > t.v;
        case '<=': return p <= t.v;
        case '>=': return p >= t.v;
        default: return p === t.v;
      }
    }
    case 'key':
      return String(v.key).toUpperCase() === t.v;
    default:
      return false;
  }
}

// `view` carries: title, description, status, category, type, priority, labels, storyPoints,
// dueDate, key, assigneeId, assigneeUsername, sprintId, sprintState, meId.
export function matches(terms, view) {
  return terms.every((t) => {
    const r = testTerm(t, view);
    return t.neg ? !r : r;
  });
}

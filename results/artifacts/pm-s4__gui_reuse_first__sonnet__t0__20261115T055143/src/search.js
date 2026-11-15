// Search query language: parser and matcher.
export class QueryError extends Error {}
const FIELDS = ['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key'];
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];

export function parseQuery(q) {
  const terms = [];
  let i = 0;
  const n = q.length;
  const bad = (m) => { const e = new Error(m); e.status = 400; e.code = 'validation_error'; throw e; };
  const readQuoted = () => {
    i++; let s = '';
    while (i < n && q[i] !== '"') { if (q[i] === '\\' && i + 1 < n) i++; s += q[i++]; }
    if (i >= n) bad('unterminated quote');
    i++;
    return s;
  };
  while (i < n) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-' && i + 1 < n && !/\s/.test(q[i + 1])) { neg = true; i++; }
    if (q[i] === '"') {
      const s = readQuoted();
      if (!s.trim()) bad('empty phrase');
      terms.push({ neg, field: 'text', value: s });
      continue;
    }
    let w = '';
    let quoted = null;
    while (i < n && !/\s/.test(q[i])) {
      if (q[i] === '"' && /^[a-z]+:$/i.test(w)) { quoted = readQuoted(); w += quoted; break; }
      if (q[i] === '"') bad('unexpected quote');
      w += q[i++];
    }
    const m = /^([A-Za-z]+):(.*)$/s.exec(quoted !== null ? w.slice(0, w.length - quoted.length) + '\u0000' : w);
    if (m) {
      const field = m[1].toLowerCase();
      if (!FIELDS.includes(field)) bad(`unknown field "${field}"`);
      const value = quoted !== null ? quoted : m[2];
      if (value === '') bad(`empty value for ${field}`);
      terms.push(buildTerm(neg, field, value, bad));
    } else {
      if (w === '' ) continue;
      terms.push({ neg, field: 'text', value: w });
    }
  }
  return terms;
}

function buildTerm(neg, field, value, bad) {
  const t = { neg, field, value };
  if (field === 'type' && !TYPES.includes(value.toLowerCase())) bad('invalid type');
  if (field === 'priority' && !PRIOS.includes(value.toLowerCase())) bad('invalid priority');
  if (field === 'is' && !['open', 'resolved'].includes(value.toLowerCase())) bad('invalid is: value');
  if (field === 'due' || field === 'points') {
    const m = /^(<=|>=|<|>|=)?(.+)$/.exec(value);
    t.op = m[1] || '=';
    t.value = m[2];
    if (field === 'due' && !/^\d{4}-\d{2}-\d{2}$/.test(t.value)) bad('invalid date');
    if (field === 'points') { if (!/^\d+(\.\d+)?$/.test(t.value)) bad('invalid number'); t.value = Number(t.value); }
  }
  return t;
}

const cmp = (op, a, b) => (op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b);

export function matchTerm(t, issue, ctx) {
  const r = rawMatch(t, issue, ctx);
  return t.neg ? !r : r;
}

function rawMatch(t, i, { user, sprints, users, userByName, projects }) {
  const v = typeof t.value === 'string' ? t.value.toLowerCase() : t.value;
  switch (t.field) {
    case 'text': return i.title.toLowerCase().includes(v) || (i.description || '').toLowerCase().includes(v);
    case 'status': return i.status.toLowerCase() === v;
    case 'type': return i.type === v;
    case 'priority': return i.priority === v;
    case 'assignee': {
      if (v === 'none') return !i.assigneeId;
      if (v === 'me') return i.assigneeId === user.id;
      const u = userByName(t.value);
      return !!u && i.assigneeId === u.id;
    }
    case 'label': return i.labels.some((l) => l.toLowerCase() === v);
    case 'sprint': {
      if (v === 'none') return !i.sprintId;
      if (!i.sprintId) return false;
      const s = sprints[i.sprintId];
      if (v === 'active') return !!s && s.state === 'active';
      return i.sprintId === t.value || (!!s && s.name.toLowerCase() === v);
    }
    case 'is': return v === 'open' ? !i.resolvedAt : !!i.resolvedAt;
    case 'due': return !!i.dueDate && cmp(t.op, i.dueDate.slice(0, 10), t.value);
    case 'points': return i.storyPoints != null && cmp(t.op, i.storyPoints, t.value);
    case 'key': return i.key.toLowerCase() === v;
    default: return false;
  }
}

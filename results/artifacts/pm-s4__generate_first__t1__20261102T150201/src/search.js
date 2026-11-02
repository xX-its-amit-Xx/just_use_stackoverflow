// Search query language: parser + matcher
const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
export class QueryError extends Error {}

export function parseQuery(q) {
  const terms = []; let i = 0; const n = q.length;
  while (i < n) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= n || /\s/.test(q[i])) throw new QueryError('dangling "-"'); }
    let text = '', colon = -1, quoted = false, inQ = false;
    while (i < n && (inQ || !/\s/.test(q[i]))) {
      const c = q[i];
      if (c === '"') { inQ = !inQ; quoted = true; }
      else { if (c === ':' && !inQ && colon < 0 && !quoted) colon = text.length; text += c; }
      i++;
    }
    if (inQ) throw new QueryError('unterminated quote');
    if (colon >= 0 && /^[A-Za-z]+$/.test(text.slice(0, colon))) {
      const field = text.slice(0, colon).toLowerCase(); const value = text.slice(colon + 1);
      if (!FIELDS.has(field)) throw new QueryError('unknown field ' + field);
      if (value === '') throw new QueryError('empty value for ' + field);
      terms.push({ neg, field, value: validate(field, value) });
    } else {
      if (text === '' && !quoted) throw new QueryError('empty term');
      terms.push({ neg, field: null, value: text.toLowerCase() });
    }
  }
  return terms;
}
function validate(field, v) {
  const l = v.toLowerCase();
  if (field === 'type') { if (!TYPES.includes(l)) throw new QueryError('bad type'); return l; }
  if (field === 'priority') { if (!PRIOS.includes(l)) throw new QueryError('bad priority'); return l; }
  if (field === 'is') { if (l !== 'open' && l !== 'resolved') throw new QueryError('bad is:'); return l; }
  if (field === 'due') {
    const m = /^([<>]=?|=)?(\d{4}-\d{2}-\d{2})$/.exec(v);
    if (!m || isNaN(Date.parse(m[2]))) throw new QueryError('bad due');
    return { op: m[1] || '=', date: m[2] };
  }
  if (field === 'points') {
    const m = /^([<>]=?|=)?(\d+(?:\.\d+)?)$/.exec(v);
    if (!m) throw new QueryError('bad points');
    return { op: m[1] || '=', n: Number(m[2]) };
  }
  return v;
}
function cmp(op, a, b) {
  switch (op) { case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b; default: return a === b; }
}
// env: { me, userById(id), sprintById(id), categoryOf(issue) }
export function matches(issue, t, env) {
  let r;
  const v = t.value;
  switch (t.field) {
    case null: r = issue.title.toLowerCase().includes(v) || (issue.description || '').toLowerCase().includes(v); break;
    case 'status': r = issue.status.toLowerCase() === v.toLowerCase(); break;
    case 'type': r = issue.type === v; break;
    case 'priority': r = issue.priority === v; break;
    case 'assignee': {
      if (v.toLowerCase() === 'none') r = !issue.assigneeId;
      else if (v.toLowerCase() === 'me') r = issue.assigneeId === env.me.id;
      else { const u = issue.assigneeId && env.userById(issue.assigneeId); r = !!u && u.username.toLowerCase() === v.toLowerCase(); }
      break;
    }
    case 'label': r = issue.labels.some(x => x.toLowerCase() === v.toLowerCase()); break;
    case 'sprint': {
      const lv = v.toLowerCase();
      if (lv === 'none') r = !issue.sprintId;
      else { const s = issue.sprintId && env.sprintById(issue.sprintId); r = !!s && (lv === 'active' ? s.state === 'active' : (s.id === v || s.name.toLowerCase() === lv)); }
      break;
    }
    case 'is': r = v === 'resolved' ? !!issue.resolvedAt : !issue.resolvedAt; break;
    case 'due': r = !!issue.dueDate && cmp(v.op, issue.dueDate, v.date); break;
    case 'points': r = issue.storyPoints != null && cmp(v.op, issue.storyPoints, v.n); break;
    case 'key': r = issue.key.toLowerCase() === v.toLowerCase(); break;
  }
  return t.neg ? !r : r;
}

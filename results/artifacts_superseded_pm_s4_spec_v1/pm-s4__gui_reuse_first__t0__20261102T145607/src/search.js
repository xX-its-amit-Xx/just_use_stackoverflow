export class QueryError extends Error {}
const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
export function parseQuery(q) {
  const terms = []; let i = 0; const n = q.length;
  const readValue = () => {
    if (q[i] === '"') {
      const e = q.indexOf('"', i + 1);
      if (e < 0) throw new QueryError('unterminated quote');
      const v = q.slice(i + 1, e); i = e + 1; return { v, quoted: true };
    }
    let s = i; while (i < n && !/\s/.test(q[i])) { if (q[i] === '"') throw new QueryError('unexpected quote'); i++; }
    return { v: q.slice(s, i), quoted: false };
  };
  while (i < n) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= n || /\s/.test(q[i])) throw new QueryError('dangling -'); }
    if (q[i] === '"') { const { v } = readValue(); terms.push({ neg, text: v }); continue; }
    const m = /^([A-Za-z]+):/.exec(q.slice(i));
    if (m) {
      const field = m[1].toLowerCase();
      if (!FIELDS.has(field)) throw new QueryError('unknown field ' + field);
      i += m[0].length;
      if (i >= n || /\s/.test(q[i])) throw new QueryError('missing value for ' + field);
      const { v } = readValue();
      if (v === '') throw new QueryError('missing value for ' + field);
      terms.push(validate({ neg, field, value: v }));
    } else { const { v } = readValue(); terms.push({ neg, text: v }); }
  }
  return terms;
}
function validate(t) {
  const { field, value } = t;
  if (field === 'is' && !['open', 'resolved'].includes(value.toLowerCase())) throw new QueryError('bad is: value');
  if (field === 'type' && !['bug', 'feature', 'task', 'epic', 'subtask'].includes(value.toLowerCase())) throw new QueryError('bad type');
  if (field === 'priority' && !['urgent', 'high', 'medium', 'low', 'none'].includes(value.toLowerCase())) throw new QueryError('bad priority');
  if (field === 'due') {
    const m = /^([<>]=?|=)?(\d{4}-\d{2}-\d{2})$/.exec(value);
    if (!m || isNaN(Date.parse(m[2]))) throw new QueryError('bad due');
    t.op = m[1] || '='; t.date = m[2];
  }
  if (field === 'points') {
    const m = /^([<>]=?|=)?(\d+(?:\.\d+)?)$/.exec(value);
    if (!m) throw new QueryError('bad points');
    t.op = m[1] || '='; t.num = Number(m[2]);
  }
  return t;
}
const cmp = (a, op, b) => op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b;
// ctx: {me, userName(id), sprintOf(issue)->sprint|null, isResolved(issue), activeSprintId(issue)->bool}
export function matches(issue, terms, ctx) {
  for (const t of terms) { if (test(issue, t, ctx) === t.neg) return false; }
  return true;
}
function test(issue, t, ctx) {
  if (t.text !== undefined) {
    const s = t.text.toLowerCase();
    return (issue.title || '').toLowerCase().includes(s) || (issue.description || '').toLowerCase().includes(s);
  }
  const v = t.value.toLowerCase();
  switch (t.field) {
    case 'status': return issue.status.toLowerCase() === v;
    case 'type': return issue.type === v;
    case 'priority': return issue.priority === v;
    case 'assignee':
      if (v === 'none') return !issue.assigneeId;
      if (v === 'me') return issue.assigneeId === ctx.me;
      return !!issue.assigneeId && (ctx.userName(issue.assigneeId) || '').toLowerCase() === v;
    case 'label': return issue.labels.some(l => l.toLowerCase() === v);
    case 'sprint':
      if (v === 'none') return !issue.sprintId;
      if (v === 'active') return !!issue.sprintId && ctx.sprintActive(issue.sprintId);
      return issue.sprintId === t.value;
    case 'is': return v === 'resolved' ? !!issue.resolvedAt : !issue.resolvedAt;
    case 'due': return !!issue.dueDate && cmp(issue.dueDate, t.op, t.date);
    case 'points': return issue.storyPoints != null && cmp(issue.storyPoints, t.op, t.num);
    case 'key': return issue.key.toLowerCase() === v;
  }
  return false;
}

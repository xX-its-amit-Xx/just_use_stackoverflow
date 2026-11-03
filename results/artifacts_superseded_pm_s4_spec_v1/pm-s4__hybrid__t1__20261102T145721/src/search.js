// Search query language parser + matcher.
const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
export class QueryError extends Error {}

export function parseQuery(q) {
  const terms = [];
  let i = 0;
  const n = q.length;
  const readQuoted = () => { // at opening quote
    i++; let s = '';
    while (i < n && q[i] !== '"') { if (q[i] === '\\' && i + 1 < n) i++; s += q[i++]; }
    if (i >= n) throw new QueryError('unterminated quote');
    i++; return s;
  };
  while (i < n) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= n || /\s/.test(q[i])) throw new QueryError('dangling negation'); }
    if (q[i] === '"') { const t = readQuoted(); if (!t) throw new QueryError('empty phrase'); terms.push({ neg, kind: 'text', value: t }); continue; }
    let w = '';
    while (i < n && !/\s/.test(q[i]) && q[i] !== ':' && q[i] !== '"') w += q[i++];
    if (i < n && q[i] === ':') {
      i++;
      const field = w.toLowerCase();
      if (!FIELDS.has(field)) throw new QueryError('unknown field: ' + w);
      let v = '';
      if (q[i] === '"') v = readQuoted();
      else while (i < n && !/\s/.test(q[i])) { if (q[i] === '"') throw new QueryError('unexpected quote'); v += q[i++]; }
      if (!v) throw new QueryError('empty value for ' + field);
      terms.push({ neg, kind: 'field', field, value: v, ...validate(field, v) });
    } else {
      if (i < n && q[i] === '"') throw new QueryError('unexpected quote');
      if (!w) throw new QueryError('bad term');
      terms.push({ neg, kind: 'text', value: w });
    }
  }
  return terms;
}
function validate(field, v) {
  const lv = v.toLowerCase();
  if (field === 'type' && !TYPES.includes(lv)) throw new QueryError('bad type');
  if (field === 'priority' && !PRIOS.includes(lv)) throw new QueryError('bad priority');
  if (field === 'is' && !['open', 'resolved'].includes(lv)) throw new QueryError('bad is value');
  if (field === 'due') {
    const m = /^([<>]=?|=)?(\d{4}-\d{2}-\d{2})$/.exec(v);
    if (!m || isNaN(Date.parse(m[2]))) throw new QueryError('bad due');
    return { op: m[1] || '=', num: m[2] };
  }
  if (field === 'points') {
    const m = /^([<>]=?|=)?(\d+(?:\.\d+)?)$/.exec(v);
    if (!m) throw new QueryError('bad points');
    return { op: m[1] || '=', num: Number(m[2]) };
  }
  return {};
}
function cmp(a, op, b) {
  switch (op) { case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b; default: return a === b; }
}
// ctx: { me, userByName(name), sprintOf(issue) }
export function matches(issue, t, ctx) {
  let r;
  if (t.kind === 'text') {
    const s = t.value.toLowerCase();
    r = (issue.title || '').toLowerCase().includes(s) || (issue.description || '').toLowerCase().includes(s);
  } else {
    const v = t.value, lv = v.toLowerCase();
    switch (t.field) {
      case 'status': r = (issue.status || '').toLowerCase() === lv; break;
      case 'type': r = issue.type === lv; break;
      case 'priority': r = issue.priority === lv; break;
      case 'assignee':
        if (lv === 'me') r = issue.assigneeId === ctx.me;
        else if (lv === 'none') r = !issue.assigneeId;
        else { const u = ctx.userByName(v); r = !!u && issue.assigneeId === u.id; }
        break;
      case 'label': r = (issue.labels || []).some(l => l.toLowerCase() === lv); break;
      case 'sprint': {
        const sp = ctx.sprintOf(issue);
        if (lv === 'none') r = !issue.sprintId;
        else if (lv === 'active') r = !!sp && sp.state === 'active';
        else r = !!issue.sprintId && (issue.sprintId === v || (!!sp && sp.name.toLowerCase() === lv));
        break;
      }
      case 'is': r = lv === 'resolved' ? !!issue.resolvedAt : !issue.resolvedAt; break;
      case 'due': r = !!issue.dueDate && cmp(issue.dueDate, t.op, t.num); break;
      case 'points': r = issue.storyPoints != null && cmp(issue.storyPoints, t.op, t.num); break;
      case 'key': r = issue.key.toLowerCase() === lv; break;
    }
  }
  return t.neg ? !r : r;
}

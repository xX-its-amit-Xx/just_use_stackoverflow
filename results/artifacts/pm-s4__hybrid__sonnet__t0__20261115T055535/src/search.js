export class QueryError extends Error {}
const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
export function parseQuery(q) {
  const terms = []; let i = 0; const n = q.length;
  while (i < n) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= n || /\s/.test(q[i])) throw new QueryError('dangling -'); }
    let word = '', quoted = false, field = null;
    while (i < n && !/\s/.test(q[i])) {
      if (q[i] === '"') {
        const e = q.indexOf('"', i + 1);
        if (e < 0) throw new QueryError('unterminated quote');
        word += q.slice(i + 1, e); quoted = true; i = e + 1;
      } else {
        if (q[i] === ':' && field === null && !quoted) { field = word; word = ''; i++; continue; }
        word += q[i++];
      }
    }
    if (field !== null) {
      field = field.toLowerCase();
      if (!FIELDS.has(field)) throw new QueryError('unknown field ' + field);
      if (word === '') throw new QueryError('empty value for ' + field);
      const t = { neg, field, value: word };
      if (field === 'due' || field === 'points') {
        const m = /^(<=|>=|<|>|=)?(.+)$/.exec(word); t.op = m[1] || '='; t.value = m[2];
        if (field === 'due' && !/^\d{4}-\d{2}-\d{2}$/.test(t.value)) throw new QueryError('bad date');
        if (field === 'points' && (t.value.trim() === '' || isNaN(Number(t.value)))) throw new QueryError('bad number');
      }
      if (field === 'is' && !['open', 'resolved'].includes(word.toLowerCase())) throw new QueryError('bad is:');
      if (field === 'type' && !['bug', 'feature', 'task', 'epic', 'subtask'].includes(word.toLowerCase())) throw new QueryError('bad type');
      if (field === 'priority' && !['urgent', 'high', 'medium', 'low', 'none'].includes(word.toLowerCase())) throw new QueryError('bad priority');
      terms.push(t);
    } else {
      if (word === '' && !quoted) throw new QueryError('empty term');
      terms.push({ neg, field: 'text', value: word });
    }
  }
  return terms;
}
const cmp = (a, op, b) => op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b;
// ctx: { me, userById(id), sprintById(id), usernameOf(id) }
export function matches(issue, t, ctx) {
  const v = t.value, lv = v.toLowerCase();
  switch (t.field) {
    case 'text': return (issue.title || '').toLowerCase().includes(lv) || (issue.description || '').toLowerCase().includes(lv);
    case 'status': return issue.status.toLowerCase() === lv;
    case 'type': return issue.type === lv;
    case 'priority': return issue.priority === lv;
    case 'assignee':
      if (lv === 'none') return !issue.assigneeId;
      if (lv === 'me') return issue.assigneeId === ctx.me;
      return !!issue.assigneeId && (ctx.usernameOf(issue.assigneeId) || '').toLowerCase() === lv;
    case 'label': return issue.labels.some(l => l.toLowerCase() === lv);
    case 'sprint':
      if (lv === 'none') return !issue.sprintId;
      if (lv === 'active') { const s = issue.sprintId && ctx.sprintById(issue.sprintId); return !!s && s.state === 'active'; }
      return issue.sprintId === v;
    case 'is': return lv === 'resolved' ? !!issue.resolvedAt : !issue.resolvedAt;
    case 'due': return !!issue.dueDate && cmp(issue.dueDate.slice(0, 10), t.op, v);
    case 'points': return issue.storyPoints != null && cmp(issue.storyPoints, t.op, Number(v));
    case 'key': return issue.key.toLowerCase() === lv;
  }
  return false;
}

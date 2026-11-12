const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];

export class QueryError extends Error {}

export function parseQuery(q) {
  const terms = [];
  let i = 0;
  const n = q.length;
  const readQuoted = () => {
    // at opening quote
    i++;
    let s = '';
    while (i < n && q[i] !== '"') { if (q[i] === '\\' && i + 1 < n) i++; s += q[i++]; }
    if (i >= n) throw new QueryError('unterminated quote');
    i++;
    return s;
  };
  while (i < n) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= n || /\s/.test(q[i])) throw new QueryError('dangling "-"'); }
    if (q[i] === '"') {
      const s = readQuoted();
      if (!s.trim()) throw new QueryError('empty phrase');
      terms.push({ neg, field: 'text', value: s });
      continue;
    }
    let word = '';
    let quoted = false;
    while (i < n && !/\s/.test(q[i])) {
      if (q[i] === '"') {
        if (!word.endsWith(':')) throw new QueryError('unexpected quote');
        word += readQuoted(); quoted = true; break;
      }
      word += q[i++];
    }
    const m = /^([A-Za-z]+):([\s\S]*)$/.exec(word);
    if (!m) { terms.push({ neg, field: 'text', value: word }); continue; }
    const field = m[1].toLowerCase();
    let value = m[2];
    if (!FIELDS.has(field)) throw new QueryError(`unknown field "${field}"`);
    if (value === '' && !quoted) throw new QueryError(`missing value for "${field}"`);
    const t = { neg, field, value };
    if (field === 'due' || field === 'points') {
      const mm = /^(<=|>=|<|>|=)?(.*)$/.exec(value);
      t.op = mm[1] || '=';
      t.value = mm[2];
      if (field === 'due') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t.value) || isNaN(Date.parse(t.value))) throw new QueryError('bad date');
      } else {
        if (t.value === '' || isNaN(Number(t.value))) throw new QueryError('bad number');
        t.value = Number(t.value);
      }
    } else if (field === 'type') {
      t.value = value.toLowerCase();
      if (!TYPES.includes(t.value)) throw new QueryError('bad type');
    } else if (field === 'priority') {
      t.value = value.toLowerCase();
      if (!PRIOS.includes(t.value)) throw new QueryError('bad priority');
    } else if (field === 'is') {
      t.value = value.toLowerCase();
      if (!['open', 'resolved'].includes(t.value)) throw new QueryError('bad is: value');
    }
    terms.push(t);
  }
  return terms;
}

const cmp = (op, a, b) => op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b;

// ctx: { userId, usernameOf(id), categoryOf(issue), sprintOf(id), userByName(name) }
export function matches(terms, issue, ctx) {
  for (const t of terms) {
    let r = evalTerm(t, issue, ctx);
    if (t.neg) r = !r;
    if (!r) return false;
  }
  return true;
}

function evalTerm(t, issue, ctx) {
  const v = t.value;
  switch (t.field) {
    case 'text': {
      const s = v.toLowerCase();
      return (issue.title || '').toLowerCase().includes(s) || (issue.description || '').toLowerCase().includes(s);
    }
    case 'status': return issue.status.toLowerCase() === v.toLowerCase();
    case 'type': return issue.type === v;
    case 'priority': return issue.priority === v;
    case 'assignee': {
      const l = v.toLowerCase();
      if (l === 'none') return !issue.assigneeId;
      if (l === 'me') return !!issue.assigneeId && issue.assigneeId === ctx.userId;
      return !!issue.assigneeId && (ctx.usernameOf(issue.assigneeId) || '').toLowerCase() === l;
    }
    case 'label': return issue.labels.some(x => x.toLowerCase() === v.toLowerCase());
    case 'sprint': {
      const l = v.toLowerCase();
      if (l === 'none') return !issue.sprintId;
      if (!issue.sprintId) return false;
      if (l === 'active') return ctx.sprintOf(issue.sprintId)?.state === 'active';
      if (issue.sprintId === v) return true;
      return (ctx.sprintOf(issue.sprintId)?.name || '').toLowerCase() === l;
    }
    case 'is': { const done = ctx.categoryOf(issue) === 'completed'; return v === 'resolved' ? done : !done; }
    case 'due': return !!issue.dueDate && cmp(t.op, issue.dueDate, v);
    case 'points': return issue.storyPoints !== null && issue.storyPoints !== undefined && cmp(t.op, issue.storyPoints, v);
    case 'key': return issue.key.toLowerCase() === v.toLowerCase();
  }
  return false;
}

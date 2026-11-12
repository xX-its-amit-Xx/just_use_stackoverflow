// Search query language parser/evaluator for pm-s4.
export const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
const TYPES = new Set(['bug', 'feature', 'task', 'epic', 'subtask']);
const PRIORITIES = new Set(['urgent', 'high', 'medium', 'low', 'none']);

export class QueryError extends Error {}

function readQuoted(q, i) {
  // q[i] === '"'
  let j = i + 1, out = '';
  while (j < q.length && q[j] !== '"') {
    if (q[j] === '\\' && j + 1 < q.length) { out += q[j + 1]; j += 2; continue; }
    out += q[j++];
  }
  if (j >= q.length) throw new QueryError('Unterminated quote');
  return { value: out, end: j + 1 };
}

export function parseQuery(q) {
  const terms = [];
  let i = 0;
  q = String(q ?? '');
  while (i < q.length) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') {
      neg = true; i++;
      if (i >= q.length || /\s/.test(q[i])) throw new QueryError('Dangling negation');
    }
    if (q[i] === '"') {
      const { value, end } = readQuoted(q, i);
      i = end;
      if (i < q.length && !/\s/.test(q[i])) throw new QueryError('Unexpected character after quote');
      if (!value.trim()) throw new QueryError('Empty phrase');
      terms.push({ field: 'text', value, neg });
      continue;
    }
    let j = i;
    while (j < q.length && !/\s/.test(q[j]) && q[j] !== ':' && q[j] !== '"') j++;
    const word = q.slice(i, j);
    if (q[j] === ':') {
      const field = word.toLowerCase();
      if (!FIELDS.has(field)) throw new QueryError(`Unknown field: ${word}`);
      j++;
      let value;
      if (q[j] === '"') {
        const r = readQuoted(q, j); value = r.value; j = r.end;
        if (j < q.length && !/\s/.test(q[j])) throw new QueryError('Unexpected character after quote');
      } else {
        let k = j;
        while (k < q.length && !/\s/.test(q[k])) k++;
        value = q.slice(j, k); j = k;
        if (value.includes('"')) throw new QueryError('Unexpected quote');
      }
      if (value === '') throw new QueryError(`Missing value for ${field}`);
      terms.push(validateTerm({ field, value, neg }));
      i = j;
    } else if (q[j] === '"') {
      throw new QueryError('Unexpected quote');
    } else {
      if (!word) throw new QueryError('Malformed query');
      terms.push({ field: 'text', value: word, neg });
      i = j;
    }
  }
  return terms;
}

function parseCmp(value, kind) {
  const m = /^(<=|>=|<|>|=)?(.+)$/.exec(value);
  if (!m) throw new QueryError(`Bad ${kind} value`);
  const op = m[1] || '=';
  const v = m[2];
  if (kind === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))) throw new QueryError('Bad date');
    return { op, v };
  }
  const n = Number(v);
  if (!Number.isFinite(n) || v.trim() === '') throw new QueryError('Bad number');
  return { op, v: n };
}

function validateTerm(t) {
  const v = t.value;
  switch (t.field) {
    case 'type': if (!TYPES.has(v.toLowerCase())) throw new QueryError('Bad type'); t.value = v.toLowerCase(); break;
    case 'priority': if (!PRIORITIES.has(v.toLowerCase())) throw new QueryError('Bad priority'); t.value = v.toLowerCase(); break;
    case 'is': if (!['open', 'resolved'].includes(v.toLowerCase())) throw new QueryError('Bad is: value'); t.value = v.toLowerCase(); break;
    case 'due': t.cmp = parseCmp(v, 'date'); break;
    case 'points': t.cmp = parseCmp(v, 'number'); break;
  }
  return t;
}

function cmp(a, op, b) {
  switch (op) {
    case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b; default: return a === b;
  }
}

// ctx: { me, userByName(name), activeSprintIds: Set, sprintIdsByName }
export function matchTerm(issue, t, ctx) {
  let r;
  switch (t.field) {
    case 'text': {
      const s = t.value.toLowerCase();
      r = (issue.title || '').toLowerCase().includes(s) || (issue.description || '').toLowerCase().includes(s);
      break;
    }
    case 'status': r = (issue.status || '').toLowerCase() === t.value.toLowerCase(); break;
    case 'type': r = issue.type === t.value; break;
    case 'priority': r = issue.priority === t.value; break;
    case 'assignee': {
      const v = t.value.toLowerCase();
      if (v === 'me') r = issue.assigneeId === ctx.me;
      else if (v === 'none') r = !issue.assigneeId;
      else { const u = ctx.userByName(t.value); r = !!u && issue.assigneeId === u.id; }
      break;
    }
    case 'label': r = (issue.labels || []).some(l => l.toLowerCase() === t.value.toLowerCase()); break;
    case 'sprint': {
      const v = t.value.toLowerCase();
      if (v === 'active') r = !!issue.sprintId && ctx.activeSprintIds.has(issue.sprintId);
      else if (v === 'none') r = !issue.sprintId;
      else r = issue.sprintId === t.value || (!!issue.sprintId && ctx.sprintName(issue.sprintId)?.toLowerCase() === v);
      break;
    }
    case 'is': r = t.value === 'resolved' ? !!issue.resolvedAt : !issue.resolvedAt; break;
    case 'due': r = !!issue.dueDate && cmp(issue.dueDate.slice(0, 10), t.cmp.op, t.cmp.v); break;
    case 'points': r = typeof issue.storyPoints === 'number' && cmp(issue.storyPoints, t.cmp.op, t.cmp.v); break;
    case 'key': r = issue.key.toUpperCase() === t.value.toUpperCase(); break;
    default: r = false;
  }
  return t.neg ? !r : r;
}

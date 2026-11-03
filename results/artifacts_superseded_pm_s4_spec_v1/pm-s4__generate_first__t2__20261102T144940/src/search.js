// Search query language parser + matcher
export class QueryError extends Error {}
const FIELDS = ['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key'];
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];

export function parseQuery(q) {
  const terms = [];
  let i = 0;
  const n = q.length;
  const readQuoted = () => {
    i++; let s = '';
    while (i < n && q[i] !== '"') { if (q[i] === '\\' && i + 1 < n) i++; s += q[i++]; }
    if (i >= n) throw new QueryError('unterminated quote');
    i++; return s;
  };
  while (i < n) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= n || /\s/.test(q[i])) throw new QueryError('dangling negation'); }
    const m = /^([A-Za-z]+):/.exec(q.slice(i));
    if (m) {
      const field = m[1].toLowerCase();
      if (!FIELDS.includes(field)) throw new QueryError(`unknown field ${field}`);
      i += m[0].length;
      let value;
      if (q[i] === '"') value = readQuoted();
      else { let s = ''; while (i < n && !/\s/.test(q[i])) { if (q[i] === '"') throw new QueryError('unexpected quote'); s += q[i++]; } value = s; }
      if (value === '') throw new QueryError(`empty value for ${field}`);
      terms.push({ neg, ...buildField(field, value) });
    } else if (q[i] === '"') {
      const p = readQuoted();
      if (p === '') throw new QueryError('empty phrase');
      terms.push({ neg, kind: 'text', text: p.toLowerCase() });
    } else {
      let s = ''; while (i < n && !/\s/.test(q[i])) { if (q[i] === '"') throw new QueryError('unexpected quote'); s += q[i++]; }
      terms.push({ neg, kind: 'text', text: s.toLowerCase() });
    }
  }
  return terms;
}

function cmp(value) {
  const m = /^(<=|>=|<|>|=)?(.*)$/.exec(value);
  return { op: m[1] || '=', rest: m[2] };
}
function buildField(field, value) {
  const v = value.toLowerCase();
  switch (field) {
    case 'type': if (!TYPES.includes(v)) throw new QueryError('bad type'); return { kind: 'type', v };
    case 'priority': if (!PRIOS.includes(v)) throw new QueryError('bad priority'); return { kind: 'priority', v };
    case 'is': if (!['open', 'resolved'].includes(v)) throw new QueryError('bad is value'); return { kind: 'is', v };
    case 'due': {
      const { op, rest } = cmp(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rest) || isNaN(Date.parse(rest))) throw new QueryError('bad date');
      return { kind: 'due', op, v: rest };
    }
    case 'points': {
      const { op, rest } = cmp(value);
      if (rest === '' || isNaN(Number(rest))) throw new QueryError('bad number');
      return { kind: 'points', op, v: Number(rest) };
    }
    default: return { kind: field, v: value };
  }
}
const test = (op, a, b) => op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b;

// ctx: { me, userById(id), usernameToId(name), sprintById(id), categoryOf(issue) }
export function matches(issue, t, ctx) {
  let r;
  switch (t.kind) {
    case 'text': r = (issue.title + '\n' + (issue.description || '')).toLowerCase().includes(t.text); break;
    case 'status': r = issue.status.toLowerCase() === t.v.toLowerCase(); break;
    case 'type': r = issue.type === t.v; break;
    case 'priority': r = issue.priority === t.v; break;
    case 'assignee': {
      const lv = t.v.toLowerCase();
      if (lv === 'none') r = !issue.assigneeId;
      else if (lv === 'me') r = issue.assigneeId === ctx.me;
      else { const u = ctx.userByName(lv); r = !!u && issue.assigneeId === u.id; }
      break;
    }
    case 'label': r = issue.labels.some(l => l.toLowerCase() === t.v.toLowerCase()); break;
    case 'sprint': {
      const lv = t.v.toLowerCase();
      if (lv === 'none') r = !issue.sprintId;
      else if (lv === 'active') { const s = issue.sprintId && ctx.sprintById(issue.sprintId); r = !!s && s.state === 'active'; }
      else { const s = issue.sprintId && ctx.sprintById(issue.sprintId); r = issue.sprintId === t.v || (!!s && s.name.toLowerCase() === lv); }
      break;
    }
    case 'is': r = (ctx.categoryOf(issue) === 'completed') === (t.v === 'resolved'); break;
    case 'due': r = !!issue.dueDate && test(t.op, issue.dueDate, t.v); break;
    case 'points': r = issue.storyPoints != null && test(t.op, issue.storyPoints, t.v); break;
    case 'key': r = issue.key.toLowerCase() === t.v.toLowerCase(); break;
    default: r = false;
  }
  return t.neg ? !r : r;
}

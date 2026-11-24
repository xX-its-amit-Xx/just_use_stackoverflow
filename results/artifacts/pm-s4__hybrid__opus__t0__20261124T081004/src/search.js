// Search query language parser/matcher.
export class QueryError extends Error {}
const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];

export function parseQuery(q) {
  const terms = [];
  const re = /\s*(-?)(?:([A-Za-z_]+):(?:"([^"]*)"|([^\s"]*))|"([^"]*)"|([^\s]+))/y;
  let pos = 0; q = q || '';
  while (pos < q.length) {
    if (/^\s*$/.test(q.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(q);
    if (!m) throw new QueryError('malformed query near position ' + pos);
    pos = re.lastIndex;
    const neg = m[1] === '-';
    if (m[2] !== undefined) {
      const field = m[2].toLowerCase();
      const value = m[3] !== undefined ? m[3] : m[4];
      // ensure quoted value was followed by whitespace/end
      if (pos < q.length && !/\s/.test(q[pos])) throw new QueryError('malformed query near position ' + pos);
      if (!FIELDS.has(field)) throw new QueryError('unknown field: ' + field);
      if (value === '' ) throw new QueryError('missing value for ' + field);
      terms.push(validate({ neg, field, value }));
    } else if (m[5] !== undefined) {
      if (pos < q.length && !/\s/.test(q[pos])) throw new QueryError('malformed query near position ' + pos);
      terms.push({ neg, field: 'text', value: m[5].toLowerCase() });
    } else {
      const w = m[6];
      if (w.includes('"')) throw new QueryError('unbalanced quote');
      if (w === '-' ) throw new QueryError('dangling negation');
      terms.push({ neg, field: 'text', value: w.toLowerCase() });
    }
  }
  return terms;
}

function validate(t) {
  const v = t.value;
  switch (t.field) {
    case 'type': if (!TYPES.includes(v.toLowerCase())) throw new QueryError('invalid type'); t.value = v.toLowerCase(); break;
    case 'priority': if (!PRIOS.includes(v.toLowerCase())) throw new QueryError('invalid priority'); t.value = v.toLowerCase(); break;
    case 'is': if (!['open', 'resolved', 'unresolved', 'closed', 'done'].includes(v.toLowerCase())) throw new QueryError('invalid is: value'); t.value = ['resolved', 'closed', 'done'].includes(v.toLowerCase()) ? 'resolved' : 'open'; break;
    case 'due': {
      const m = /^(<=|>=|<|>|=)?(\d{4}-\d{2}-\d{2})$/.exec(v);
      if (!m || isNaN(Date.parse(m[2] + 'T00:00:00Z'))) throw new QueryError('invalid due: value');
      t.op = m[1] || '='; t.value = m[2]; break;
    }
    case 'points': {
      const m = /^(<=|>=|<|>|=)?(\d+(?:\.\d+)?)$/.exec(v);
      if (!m) throw new QueryError('invalid points: value');
      t.op = m[1] || '='; t.value = Number(m[2]); break;
    }
  }
  return t;
}

function cmp(op, a, b) {
  switch (op) { case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b; default: return a === b; }
}

// ctx: { userId, userByName(name), category(issue), activeSprintIds:Set }
export function matches(issue, terms, ctx) {
  for (const t of terms) {
    let r = matchTerm(issue, t, ctx);
    if (t.neg) r = !r;
    if (!r) return false;
  }
  return true;
}

function matchTerm(issue, t, ctx) {
  const v = t.value;
  switch (t.field) {
    case 'text': return (issue.title || '').toLowerCase().includes(v) || (issue.description || '').toLowerCase().includes(v);
    case 'status': return (issue.status || '').toLowerCase() === v.toLowerCase();
    case 'type': return issue.type === v;
    case 'priority': return issue.priority === v;
    case 'assignee': {
      const lv = v.toLowerCase();
      if (lv === 'none' || lv === 'unassigned') return !issue.assigneeId;
      if (lv === 'me') return issue.assigneeId === ctx.userId;
      const u = ctx.userByName(v);
      return !!u && issue.assigneeId === u.id;
    }
    case 'label': return (issue.labels || []).some(l => l.toLowerCase() === v.toLowerCase());
    case 'sprint': {
      const lv = v.toLowerCase();
      if (lv === 'none' || lv === 'backlog') return !issue.sprintId;
      if (lv === 'active') return !!issue.sprintId && ctx.activeSprintIds.has(issue.sprintId);
      return issue.sprintId === v;
    }
    case 'is': return v === 'resolved' ? ctx.category(issue) === 'completed' : ctx.category(issue) !== 'completed';
    case 'due': return !!issue.dueDate && cmp(t.op, issue.dueDate.slice(0, 10), v);
    case 'points': return typeof issue.storyPoints === 'number' && cmp(t.op, issue.storyPoints, v);
    case 'key': return issue.key.toLowerCase() === v.toLowerCase();
  }
  return false;
}

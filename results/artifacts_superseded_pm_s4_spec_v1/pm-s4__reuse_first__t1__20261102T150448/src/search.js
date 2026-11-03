// Search query language parser -> predicate builder.
export const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const FIELDS = ['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key'];

export class QueryError extends Error {}

export function tokenize(q) {
  const out = [];
  let i = 0;
  const n = q.length;
  const readQuoted = () => {
    // at opening quote
    let j = i + 1, s = '';
    while (j < n && q[j] !== '"') { if (q[j] === '\\' && j + 1 < n) j++; s += q[j++]; }
    if (j >= n) throw new QueryError('unterminated quote');
    i = j + 1;
    return s;
  };
  while (i < n) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= n || /\s/.test(q[i])) throw new QueryError('dangling -'); }
    if (q[i] === '"') { out.push({ neg, text: readQuoted() }); continue; }
    const m = /^([A-Za-z]+):/.exec(q.slice(i));
    if (m) {
      i += m[0].length;
      let value;
      if (q[i] === '"') value = readQuoted();
      else { let j = i; while (j < n && !/\s/.test(q[j])) j++; value = q.slice(i, j); i = j; }
      if (value === '') throw new QueryError(`empty value for ${m[1]}`);
      out.push({ neg, field: m[1].toLowerCase(), value });
      continue;
    }
    let j = i; while (j < n && !/\s/.test(q[j])) { if (q[j] === '"') throw new QueryError('unexpected quote'); j++; }
    out.push({ neg, text: q.slice(i, j) }); i = j;
  }
  return out;
}

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
function cmp(value, label, isDate) {
  const m = /^(>=|<=|>|<|=)?(.+)$/.exec(value);
  const op = m[1] || '=';
  let v = m[2];
  if (isDate) { if (!dateRe.test(v) || isNaN(Date.parse(v))) throw new QueryError(`bad date for ${label}`); }
  else { v = Number(v); if (!Number.isFinite(v)) throw new QueryError(`bad number for ${label}`); }
  return x => {
    if (x == null) return false;
    if (isDate) x = String(x).slice(0, 10);
    switch (op) { case '>': return x > v; case '<': return x < v; case '>=': return x >= v; case '<=': return x <= v; default: return x === v; }
  };
}

// ctx: { me, userByName(name), sprintState(id), isDone(issue), username(id) }
export function buildPredicate(q, ctx) {
  const terms = tokenize(q || '');
  const preds = terms.map(t => {
    let p;
    if (t.text !== undefined) {
      const needle = t.text.toLowerCase();
      p = is => (is.title || '').toLowerCase().includes(needle) || (is.description || '').toLowerCase().includes(needle);
    } else {
      const v = t.value, lv = v.toLowerCase();
      switch (t.field) {
        case 'status': p = is => is.status.toLowerCase() === lv; break;
        case 'type': if (!TYPES.includes(lv)) throw new QueryError('bad type'); p = is => is.type === lv; break;
        case 'priority': if (!PRIORITIES.includes(lv)) throw new QueryError('bad priority'); p = is => is.priority === lv; break;
        case 'assignee':
          if (lv === 'none') p = is => !is.assigneeId;
          else if (lv === 'me') p = is => !!ctx.me && is.assigneeId === ctx.me;
          else p = is => !!is.assigneeId && (ctx.username(is.assigneeId) || '').toLowerCase() === lv;
          break;
        case 'label': p = is => is.labels.some(l => l.toLowerCase() === lv); break;
        case 'sprint':
          if (lv === 'none') p = is => !is.sprintId;
          else if (lv === 'active') p = is => !!is.sprintId && ctx.sprintState(is.sprintId) === 'active';
          else p = is => is.sprintId === v;
          break;
        case 'is':
          if (lv === 'open') p = is => !ctx.isDone(is);
          else if (lv === 'resolved') p = is => ctx.isDone(is);
          else throw new QueryError('bad is: value');
          break;
        case 'due': { const f = cmp(v, 'due', true); p = is => f(is.dueDate); break; }
        case 'points': { const f = cmp(v, 'points', false); p = is => f(is.storyPoints); break; }
        case 'key': p = is => is.key.toLowerCase() === lv; break;
        default: throw new QueryError(`unknown field ${t.field}`);
      }
    }
    return t.neg ? is => !p(is) : p;
  });
  return is => preds.every(p => p(is));
}
export { FIELDS };

// Search query language parser (pm-s4). Written for this project.
// Grammar: terms separated by whitespace, ANDed. Each term: [-] ( field:value | field:"quoted value" | "phrase" | word )

export class QueryError extends Error {}

const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key', 'text']);
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];

function readQuoted(q, i) {
  // q[i] === '"'
  let j = i + 1;
  let out = '';
  while (j < q.length) {
    if (q[j] === '\\' && q[j + 1] === '"') { out += '"'; j += 2; continue; }
    if (q[j] === '"') return { value: out, end: j + 1 };
    out += q[j++];
  }
  throw new QueryError('Unterminated quoted string');
}

export function tokenize(q) {
  const terms = [];
  let i = 0;
  while (i < q.length) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') {
      neg = true; i++;
      if (i >= q.length || /\s/.test(q[i])) throw new QueryError('Dangling negation');
    }
    if (q[i] === '"') {
      const { value, end } = readQuoted(q, i);
      if (end < q.length && !/\s/.test(q[end])) throw new QueryError('Unexpected character after quoted phrase');
      if (!value.trim()) throw new QueryError('Empty phrase');
      terms.push({ field: 'text', value, neg });
      i = end; continue;
    }
    let j = i;
    while (j < q.length && !/\s/.test(q[j]) && q[j] !== ':' && q[j] !== '"') j++;
    if (q[j] === ':') {
      const field = q.slice(i, j).toLowerCase();
      if (!FIELDS.has(field) || field === 'text') throw new QueryError(`Unknown field "${q.slice(i, j)}"`);
      j++;
      let value;
      if (q[j] === '"') {
        const r = readQuoted(q, j); value = r.value; j = r.end;
        if (j < q.length && !/\s/.test(q[j])) throw new QueryError('Unexpected character after quoted value');
      } else {
        const s = j;
        while (j < q.length && !/\s/.test(q[j])) { if (q[j] === '"') throw new QueryError('Unexpected quote'); j++; }
        value = q.slice(s, j);
      }
      if (value === '') throw new QueryError(`Missing value for "${field}"`);
      terms.push({ field, value, neg });
      i = j; continue;
    }
    if (q[j] === '"') throw new QueryError('Unexpected quote');
    terms.push({ field: 'text', value: q.slice(i, j), neg });
    i = j;
  }
  return terms;
}

function parseCmp(value, kind) {
  const m = /^(<=|>=|<|>|=)?(.*)$/.exec(value);
  const op = m[1] || '=';
  const raw = m[2];
  if (kind === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || isNaN(Date.parse(raw))) throw new QueryError(`Invalid date "${raw}"`);
    return { op, v: raw };
  }
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new QueryError(`Invalid number "${raw}"`);
  return { op, v: Number(raw) };
}

function cmp(a, op, b) {
  switch (op) {
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    default: return a === b;
  }
}

/**
 * Compile a query into a predicate.
 * ctx: { meId, userByName(name) -> user|null, isResolved(issue) -> bool, activeSprintId(projectId) -> id|null }
 */
export function compileQuery(q, ctx) {
  const terms = tokenize(q || '');
  const preds = terms.map(t => {
    const v = t.value;
    const lv = v.toLowerCase();
    let p;
    switch (t.field) {
      case 'text': p = i => (i.title || '').toLowerCase().includes(lv) || (i.description || '').toLowerCase().includes(lv); break;
      case 'status': p = i => (i.status || '').toLowerCase() === lv; break;
      case 'type':
        if (!TYPES.includes(lv)) throw new QueryError(`Invalid type "${v}"`);
        p = i => i.type === lv; break;
      case 'priority':
        if (!PRIORITIES.includes(lv)) throw new QueryError(`Invalid priority "${v}"`);
        p = i => i.priority === lv; break;
      case 'assignee':
        if (lv === 'me') p = i => i.assigneeId === ctx.meId;
        else if (lv === 'none') p = i => !i.assigneeId;
        else { const u = ctx.userByName(v); p = i => !!u && i.assigneeId === u.id; }
        break;
      case 'label': p = i => (i.labels || []).some(l => l.toLowerCase() === lv); break;
      case 'sprint':
        if (lv === 'none') p = i => !i.sprintId;
        else if (lv === 'active') p = i => !!i.sprintId && i.sprintId === ctx.activeSprintId(i.projectId);
        else p = i => i.sprintId === v;
        break;
      case 'is':
        if (lv === 'open' || lv === 'unresolved') p = i => !ctx.isResolved(i);
        else if (lv === 'resolved' || lv === 'closed' || lv === 'done') p = i => ctx.isResolved(i);
        else throw new QueryError(`Invalid is: value "${v}"`);
        break;
      case 'due': {
        const c = parseCmp(v, 'date');
        p = i => !!i.dueDate && cmp(String(i.dueDate).slice(0, 10), c.op, c.v); break;
      }
      case 'points': {
        const c = parseCmp(v, 'number');
        p = i => typeof i.storyPoints === 'number' && cmp(i.storyPoints, c.op, c.v); break;
      }
      case 'key': p = i => (i.key || '').toLowerCase() === lv; break;
      default: throw new QueryError(`Unknown field "${t.field}"`);
    }
    return t.neg ? i => !p(i) : p;
  });
  return issue => preds.every(p => p(issue));
}

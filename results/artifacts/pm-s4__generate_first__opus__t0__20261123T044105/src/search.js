// Search query language parser (original implementation).

export class QueryError extends Error {}

const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'reporter', 'label', 'sprint', 'is', 'due', 'points', 'key', 'project', 'epic', 'parent', 'text']);
export const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];

function readQuoted(q, i) {
  // q[i] === '"'
  let j = i + 1;
  let out = '';
  while (j < q.length) {
    if (q[j] === '\\' && (q[j + 1] === '"' || q[j + 1] === '\\')) { out += q[j + 1]; j += 2; continue; }
    if (q[j] === '"') return { value: out, end: j + 1 };
    out += q[j]; j++;
  }
  throw new QueryError('unterminated quoted string');
}

export function tokenize(q) {
  const terms = [];
  let i = 0;
  const isWs = c => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  while (i < q.length) {
    while (i < q.length && isWs(q[i])) i++;
    if (i >= q.length) break;
    let negate = false;
    if (q[i] === '-' && i + 1 < q.length && !isWs(q[i + 1])) { negate = true; i++; }
    let field = null;
    let value;
    let quoted = false;
    if (q[i] === '"') {
      const r = readQuoted(q, i); value = r.value; i = r.end; quoted = true;
      if (i < q.length && !isWs(q[i])) throw new QueryError('unexpected character after quoted string');
    } else {
      let j = i;
      while (j < q.length && !isWs(q[j]) && q[j] !== ':' && q[j] !== '"') j++;
      const word = q.slice(i, j);
      if (q[j] === ':' && word.length > 0) {
        field = word.toLowerCase();
        j++;
        if (q[j] === '"') {
          const r = readQuoted(q, j); value = r.value; j = r.end; quoted = true;
          if (j < q.length && !isWs(q[j])) throw new QueryError('unexpected character after quoted string');
        } else {
          let k = j;
          while (k < q.length && !isWs(q[k])) { if (q[k] === '"') throw new QueryError('unexpected quote'); k++; }
          value = q.slice(j, k); j = k;
        }
        if (value === '' && !quoted) throw new QueryError(`missing value for ${field}`);
        if (!FIELDS.has(field)) throw new QueryError(`unknown field: ${field}`);
      } else if (q[j] === '"') {
        throw new QueryError('unexpected quote');
      } else if (q[j] === ':') {
        throw new QueryError('missing field name');
      } else {
        value = word;
      }
      i = j;
    }
    terms.push({ field, value, negate, quoted });
  }
  return terms;
}

function cmpParse(v, re, label) {
  const m = re.exec(v);
  if (!m) throw new QueryError(`invalid ${label} filter: ${v}`);
  return { op: m[1] || '=', val: m[2] };
}

function compare(a, op, b) {
  switch (op) {
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    default: return a === b;
  }
}

function validDate(s) {
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// Compiles terms into predicate(issue). ctx provides: userId, findUserByName(name), sprintById(id), projectOf(issue)
export function compile(q, ctx) {
  const terms = tokenize(q || '');
  const preds = terms.map(t => {
    const p = termPredicate(t, ctx);
    return t.negate ? (iss => !p(iss)) : p;
  });
  return iss => preds.every(p => p(iss));
}

function termPredicate(t, ctx) {
  const v = t.value;
  const lv = v.toLowerCase();
  switch (t.field) {
    case null:
    case 'text':
      return iss => (iss.title || '').toLowerCase().includes(lv) || (iss.description || '').toLowerCase().includes(lv);
    case 'status':
      return iss => (iss.status || '').toLowerCase() === lv;
    case 'type':
      if (!TYPES.includes(lv)) throw new QueryError(`invalid type: ${v}`);
      return iss => iss.type === lv;
    case 'priority':
      if (!PRIORITIES.includes(lv)) throw new QueryError(`invalid priority: ${v}`);
      return iss => iss.priority === lv;
    case 'assignee':
    case 'reporter': {
      const f = t.field === 'assignee' ? 'assigneeId' : 'reporterId';
      if (lv === 'me') return iss => iss[f] === ctx.userId;
      if (lv === 'none') return iss => !iss[f];
      const u = ctx.findUserByName(v);
      if (!u) return () => false;
      return iss => iss[f] === u.id;
    }
    case 'label':
      return iss => (iss.labels || []).some(l => l.toLowerCase() === lv);
    case 'sprint':
      if (lv === 'active') return iss => { if (!iss.sprintId) return false; const s = ctx.sprintById(iss.sprintId); return !!s && s.state === 'active'; };
      if (lv === 'none') return iss => !iss.sprintId;
      return iss => { if (!iss.sprintId) return false; if (iss.sprintId === v) return true; const s = ctx.sprintById(iss.sprintId); return !!s && s.name.toLowerCase() === lv; };
    case 'is':
      if (lv === 'open') return iss => !iss.resolvedAt;
      if (lv === 'resolved' || lv === 'closed' || lv === 'done') return iss => !!iss.resolvedAt;
      throw new QueryError(`invalid is: value: ${v}`);
    case 'due': {
      const { op, val } = cmpParse(v, /^(<=|>=|<|>|=)?(\d{4}-\d{2}-\d{2})$/, 'due');
      if (!validDate(val)) throw new QueryError(`invalid date: ${val}`);
      return iss => !!iss.dueDate && compare(String(iss.dueDate).slice(0, 10), op, val);
    }
    case 'points': {
      const { op, val } = cmpParse(v, /^(<=|>=|<|>|=)?(\d+(?:\.\d+)?)$/, 'points');
      const num = Number(val);
      return iss => typeof iss.storyPoints === 'number' && compare(iss.storyPoints, op, num);
    }
    case 'key':
      return iss => iss.key.toLowerCase() === lv;
    case 'project':
      return iss => { const p = ctx.projectOf(iss); return !!p && (p.id === v || p.key.toLowerCase() === lv); };
    case 'epic':
      if (lv === 'none') return iss => !iss.epicId;
      return iss => { if (!iss.epicId) return false; const e = ctx.issueById(iss.epicId); return !!e && (e.key.toLowerCase() === lv || e.id === v); };
    case 'parent':
      if (lv === 'none') return iss => !iss.parentId;
      return iss => { if (!iss.parentId) return false; const e = ctx.issueById(iss.parentId); return !!e && (e.key.toLowerCase() === lv || e.id === v); };
    default:
      throw new QueryError(`unknown field: ${t.field}`);
  }
}

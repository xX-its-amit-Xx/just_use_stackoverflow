export class QueryError extends Error {}
const PRI = ['urgent', 'high', 'medium', 'low', 'none'];
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const FIELDS = ['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key'];
export function tokenize(q) {
  const toks = []; let i = 0; const n = q.length;
  while (i < n) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= n || /\s/.test(q[i])) throw new QueryError('dangling negation'); }
    let field = null, value = '', quoted = false;
    if (q[i] === '"') {
      const e = q.indexOf('"', i + 1); if (e < 0) throw new QueryError('unterminated quote');
      value = q.slice(i + 1, e); i = e + 1; quoted = true;
    } else {
      let w = '';
      while (i < n && !/\s/.test(q[i]) && q[i] !== '"' && q[i] !== ':') w += q[i++];
      if (i < n && q[i] === ':') {
        field = w.toLowerCase(); i++;
        if (q[i] === '"') {
          const e = q.indexOf('"', i + 1); if (e < 0) throw new QueryError('unterminated quote');
          value = q.slice(i + 1, e); i = e + 1; quoted = true;
        } else { while (i < n && !/\s/.test(q[i])) { if (q[i] === '"') throw new QueryError('unexpected quote'); value += q[i++]; } }
        if (!FIELDS.includes(field)) throw new QueryError('unknown field ' + field);
        if (value === '' && !quoted) throw new QueryError('empty value for ' + field);
      } else {
        value = w;
        if (i < n && q[i] === '"') throw new QueryError('unexpected quote');
      }
    }
    if (field === null && value === '' && !quoted) throw new QueryError('empty term');
    toks.push({ neg, field, value, quoted });
  }
  return toks;
}
function cmpOp(v) {
  const m = /^(>=|<=|>|<|=)?(.*)$/.exec(v); return { op: m[1] || '=', val: m[2] };
}
function cmp(op, a, b) { return op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : op === '<=' ? a <= b : a === b; }
// ctx: {meId, userByName(name)->user, sprintOf(issue)->sprint|null, assigneeName}
export function compile(q, ctx) {
  const preds = tokenize(q).map(t => {
    let f;
    const v = t.value, lv = v.toLowerCase();
    switch (t.field) {
      case null: f = i => (i.title + '\n' + (i.description || '')).toLowerCase().includes(lv); break;
      case 'status': f = i => (i.status || '').toLowerCase() === lv; break;
      case 'type': if (!TYPES.includes(lv)) throw new QueryError('bad type'); f = i => i.type === lv; break;
      case 'priority': if (!PRI.includes(lv)) throw new QueryError('bad priority'); f = i => i.priority === lv; break;
      case 'assignee':
        if (lv === 'none') f = i => !i.assigneeId;
        else if (lv === 'me') f = i => i.assigneeId === ctx.meId;
        else f = i => { const u = ctx.userByName(v); return !!u && i.assigneeId === u.id; };
        break;
      case 'label': f = i => i.labels.some(l => l.toLowerCase() === lv); break;
      case 'sprint':
        if (lv === 'none') f = i => !i.sprintId;
        else if (lv === 'active') f = i => { const s = ctx.sprintOf(i); return !!s && s.state === 'active'; };
        else f = i => i.sprintId === v;
        break;
      case 'is':
        if (lv === 'open') f = i => !i.resolvedAt; else if (lv === 'resolved') f = i => !!i.resolvedAt;
        else throw new QueryError('bad is value');
        break;
      case 'due': {
        const { op, val } = cmpOp(v);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(val) || isNaN(Date.parse(val))) throw new QueryError('bad date');
        f = i => !!i.dueDate && cmp(op, String(i.dueDate).slice(0, 10), val); break;
      }
      case 'points': {
        const { op, val } = cmpOp(v); const num = Number(val);
        if (val.trim() === '' || !Number.isFinite(num)) throw new QueryError('bad number');
        f = i => i.storyPoints !== null && i.storyPoints !== undefined && cmp(op, i.storyPoints, num); break;
      }
      case 'key': f = i => i.key.toLowerCase() === lv; break;
    }
    return t.neg ? i => !f(i) : f;
  });
  return i => preds.every(p => p(i));
}

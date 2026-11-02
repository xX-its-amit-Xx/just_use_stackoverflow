// Search query language parser/compiler
export class QueryError extends Error {}
export function parseQuery(q) {
  const terms = []; let i = 0; const n = q.length;
  const isSp = c => /\s/.test(c);
  while (i < n) {
    if (isSp(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= n || isSp(q[i])) throw new QueryError('dangling "-"'); }
    const readQuoted = () => { i++; let s = ''; while (i < n && q[i] !== '"') s += q[i++]; if (i >= n) throw new QueryError('unterminated quote'); i++; return s; };
    if (q[i] === '"') { const t = readQuoted(); if (!t) throw new QueryError('empty phrase'); terms.push({ neg, text: t }); continue; }
    let w = ''; const m = /^([A-Za-z]+):/.exec(q.slice(i));
    if (m) {
      i += m[0].length; let v;
      if (q[i] === '"') v = readQuoted(); else { v = ''; while (i < n && !isSp(q[i])) v += q[i++]; }
      if (v === '') throw new QueryError(`empty value for ${m[1]}`);
      terms.push({ neg, field: m[1].toLowerCase(), value: v });
    } else { while (i < n && !isSp(q[i])) w += q[i++]; terms.push({ neg, text: w }); }
  }
  return terms;
}
const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
const cmp = (op, a, b) => op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : op === '<=' ? a <= b : a === b;
// ctx: {me, userByName(name), sprintState(id)}
export function compile(terms, ctx) {
  const preds = terms.map(t => {
    let p;
    if (t.text !== undefined) { const s = t.text.toLowerCase(); p = i => (i.title || '').toLowerCase().includes(s) || (i.description || '').toLowerCase().includes(s); }
    else {
      if (!FIELDS.has(t.field)) throw new QueryError(`unknown field ${t.field}`);
      const v = t.value, lv = v.toLowerCase();
      switch (t.field) {
        case 'status': p = i => i.status.toLowerCase() === lv; break;
        case 'type': p = i => i.type === lv; break;
        case 'priority': p = i => i.priority === lv; break;
        case 'label': p = i => i.labels.some(l => l.toLowerCase() === lv); break;
        case 'key': p = i => i.key.toLowerCase() === lv; break;
        case 'assignee': {
          if (lv === 'none') p = i => !i.assigneeId;
          else { const u = lv === 'me' ? ctx.me : ctx.userByName(v); p = i => !!u && i.assigneeId === u.id; }
          break;
        }
        case 'sprint':
          if (lv === 'none') p = i => !i.sprintId;
          else if (lv === 'active') p = i => !!i.sprintId && ctx.sprintState(i.sprintId) === 'active';
          else p = i => i.sprintId === v;
          break;
        case 'is':
          if (lv === 'open') p = i => !i.resolvedAt; else if (lv === 'resolved') p = i => !!i.resolvedAt;
          else throw new QueryError('is: expects open|resolved');
          break;
        case 'due': {
          const m = /^(<=|>=|<|>|=)?(\d{4}-\d{2}-\d{2})$/.exec(v);
          if (!m || isNaN(Date.parse(m[2]))) throw new QueryError('bad date');
          p = i => !!i.dueDate && cmp(m[1] || '=', i.dueDate, m[2]); break;
        }
        case 'points': {
          const m = /^(<=|>=|<|>|=)?(\d+(?:\.\d+)?)$/.exec(v);
          if (!m) throw new QueryError('bad number');
          const num = Number(m[2]); p = i => i.storyPoints != null && cmp(m[1] || '=', i.storyPoints, num); break;
        }
      }
    }
    return t.neg ? i => !p(i) : p;
  });
  return i => preds.every(p => p(i));
}

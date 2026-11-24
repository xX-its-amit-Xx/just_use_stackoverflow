// Search query language parser/matcher (written from scratch).
export class QueryError extends Error {}

const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);

export function parseQuery(q) {
  const terms = [];
  const s = String(q || '');
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    let neg = false;
    if (s[i] === '-') {
      neg = true; i++;
      if (i >= s.length || /\s/.test(s[i])) throw new QueryError('dangling negation');
    }
    const startsQuoted = s[i] === '"';
    let tok = '', inQ = false;
    while (i < s.length && (inQ || !/\s/.test(s[i]))) {
      if (s[i] === '"') inQ = !inQ; else tok += s[i];
      i++;
    }
    if (inQ) throw new QueryError('unterminated quote');
    if (startsQuoted) {
      if (!tok.trim()) throw new QueryError('empty phrase');
      terms.push({ neg, text: tok.toLowerCase() });
      continue;
    }
    const c = tok.indexOf(':');
    if (c > 0) {
      const field = tok.slice(0, c).toLowerCase();
      const value = tok.slice(c + 1);
      if (!FIELDS.has(field)) throw new QueryError('unknown field ' + field);
      if (!value) throw new QueryError('empty value for ' + field);
      const t = { neg, field, value };
      if (field === 'due') {
        const m = /^(<=|>=|<|>|=)?(\d{4}-\d{2}-\d{2})$/.exec(value);
        if (!m) throw new QueryError('bad date');
        t.op = m[1] || '='; t.date = m[2];
      } else if (field === 'points') {
        const m = /^(<=|>=|<|>|=)?(\d+(?:\.\d+)?)$/.exec(value);
        if (!m) throw new QueryError('bad points');
        t.op = m[1] || '='; t.num = Number(m[2]);
      } else if (field === 'is') {
        if (!['open', 'resolved'].includes(value.toLowerCase())) throw new QueryError('bad is value');
      }
      terms.push(t);
    } else if (c === 0) throw new QueryError('missing field');
    else terms.push({ neg, text: tok.toLowerCase() });
  }
  return terms;
}

function cmp(op, a, b) {
  switch (op) {
    case '<': return a < b; case '>': return a > b;
    case '<=': return a <= b; case '>=': return a >= b; default: return a === b;
  }
}

// ctx: { user, usernameOf(id), sprintOf(id) }
export function matches(issue, terms, ctx) {
  for (const t of terms) {
    let r;
    if (t.text !== undefined) {
      r = issue.title.toLowerCase().includes(t.text) || (issue.description || '').toLowerCase().includes(t.text);
    } else {
      const v = t.value.toLowerCase();
      switch (t.field) {
        case 'status': r = issue.status.toLowerCase() === v; break;
        case 'type': r = issue.type === v; break;
        case 'priority': r = issue.priority === v; break;
        case 'assignee':
          if (v === 'none') r = !issue.assigneeId;
          else if (v === 'me') r = issue.assigneeId === ctx.user.id;
          else r = !!issue.assigneeId && (ctx.usernameOf(issue.assigneeId) || '').toLowerCase() === v;
          break;
        case 'label': r = issue.labels.some(l => l.toLowerCase() === v); break;
        case 'sprint': {
          if (v === 'none') r = !issue.sprintId;
          else { const sp = issue.sprintId && ctx.sprintOf(issue.sprintId); r = !!sp && (v === 'active' ? sp.state === 'active' : (sp.id === t.value || sp.name.toLowerCase() === v)); }
          break;
        }
        case 'is': r = v === 'resolved' ? !!issue.resolvedAt : !issue.resolvedAt; break;
        case 'due': r = !!issue.dueDate && cmp(t.op, String(issue.dueDate).slice(0, 10), t.date); break;
        case 'points': r = issue.storyPoints != null && cmp(t.op, issue.storyPoints, t.num); break;
        case 'key': r = issue.key.toLowerCase() === v; break;
      }
    }
    if (t.neg ? r : !r) return false;
  }
  return true;
}

// Search query language: tokenizer + parser. Throws Error on malformed query.
const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
export function tokenize(q) {
  const toks = []; let i = 0;
  while (i < q.length) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= q.length || /\s/.test(q[i])) throw new Error('dangling negation'); }
    let field = null, buf = '', quoted = false;
    const m = /^([a-z]+):/.exec(q.slice(i));
    if (m) { field = m[1]; i += m[0].length; if (!FIELDS.has(field)) throw new Error(`unknown field "${field}"`); }
    if (q[i] === '"') {
      quoted = true; i++;
      let closed = false;
      while (i < q.length) { if (q[i] === '"') { closed = true; i++; break; } buf += q[i++]; }
      if (!closed) throw new Error('unterminated quote');
    } else {
      while (i < q.length && !/\s/.test(q[i])) { if (q[i] === '"') throw new Error('unexpected quote'); buf += q[i++]; }
    }
    if (field && buf === '' ) throw new Error(`missing value for "${field}"`);
    if (!field && buf === '' && !quoted) throw new Error('empty term');
    toks.push({ neg, field, value: buf, quoted });
  }
  return toks;
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
export function parseQuery(q) {
  const terms = tokenize(q || '');
  for (const t of terms) {
    if (t.field === 'due') { const m = /^([<>]=?)?(.+)$/.exec(t.value); if (!isDate(m[2])) throw new Error('bad date'); t.op = m[1] || '='; t.arg = m[2]; }
    else if (t.field === 'points') { const m = /^([<>]=?|=)?(\d+(?:\.\d+)?)$/.exec(t.value); if (!m) throw new Error('bad points'); t.op = m[1] || '='; t.arg = Number(m[2]); }
    else if (t.field === 'is' && !['open', 'resolved'].includes(t.value.toLowerCase())) throw new Error('is: expects open|resolved');
  }
  return terms;
}
const cmp = (op, a, b) => op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b;
// ctx: { me, userById, sprintById, isDone(issue), project }
export function matches(issue, t, ctx) {
  const lc = (x) => String(x ?? '').toLowerCase(), v = lc(t.value);
  switch (t.field) {
    case null: return lc(issue.title).includes(v) || lc(issue.description).includes(v);
    case 'status': return lc(issue.status) === v;
    case 'type': return lc(issue.type) === v;
    case 'priority': return lc(issue.priority) === v;
    case 'assignee': {
      if (v === 'none') return !issue.assigneeId;
      const u = v === 'me' ? ctx.me : ctx.userByName(v);
      return !!u && issue.assigneeId === u.id;
    }
    case 'label': return issue.labels.some((l) => lc(l) === v);
    case 'sprint': {
      if (v === 'none') return !issue.sprintId;
      if (!issue.sprintId) return false;
      if (v === 'active') return ctx.sprintById(issue.sprintId)?.state === 'active';
      return issue.sprintId === t.value;
    }
    case 'is': return v === 'resolved' ? ctx.isDone(issue) : !ctx.isDone(issue);
    case 'due': return !!issue.dueDate && cmp(t.op, issue.dueDate.slice(0, 10), t.arg);
    case 'points': return issue.storyPoints != null && cmp(t.op, issue.storyPoints, t.arg);
    case 'key': return lc(issue.key) === v;
  }
  return false;
}

const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const FIELDS = ['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key'];
const err = (m) => Object.assign(new Error(m), { status: 400, error: 'validation_error' });

export function parseSearch(q) {
  const terms = []; let i = 0; const n = q.length;
  const quoted = () => {
    i++; let s = '';
    while (i < n && q[i] !== '"') { if (q[i] === '\\' && i + 1 < n) i++; s += q[i++]; }
    if (i >= n) throw err('unterminated quote');
    i++; return s;
  };
  while (i < n) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= n || /\s/.test(q[i])) throw err('dangling -'); }
    if (q[i] === '"') { const t = quoted(); if (!t.trim()) throw err('empty phrase'); terms.push({ neg, field: null, value: t }); continue; }
    let w = ''; while (i < n && !/\s/.test(q[i]) && q[i] !== '"' && q[i] !== ':') w += q[i++];
    if (i < n && q[i] === ':') {
      i++; let v;
      if (q[i] === '"') v = quoted(); else { v = ''; while (i < n && !/\s/.test(q[i])) { if (q[i] === '"') throw err('unexpected quote'); v += q[i++]; } }
      const field = w.toLowerCase();
      if (!FIELDS.includes(field)) throw err(`unknown field "${w}"`);
      if (!v) throw err(`empty value for ${field}`);
      terms.push({ neg, field, value: v, ...validate(field, v) });
    } else {
      if (i < n && q[i] === '"') throw err('unexpected quote');
      terms.push({ neg, field: null, value: w });
    }
  }
  return terms;
}
function cmpSpec(v, isDate) {
  const m = /^(<=|>=|<|>|=)?(.+)$/.exec(v); const op = m[1] || '=';
  if (isDate) { if (!/^\d{4}-\d{2}-\d{2}$/.test(m[2]) || isNaN(Date.parse(m[2]))) throw err('invalid date'); return { op, arg: m[2] }; }
  const num = Number(m[2]); if (m[2].trim() === '' || !isFinite(num)) throw err('invalid number'); return { op, arg: num };
}
function validate(field, v) {
  const l = v.toLowerCase();
  if (field === 'type' && !TYPES.includes(l)) throw err('invalid type');
  if (field === 'priority' && !PRIOS.includes(l)) throw err('invalid priority');
  if (field === 'is' && !['open', 'resolved'].includes(l)) throw err('invalid is: value');
  if (field === 'due') return { cmp: cmpSpec(v, true) };
  if (field === 'points') return { cmp: cmpSpec(v, false) };
  return {};
}
const test = (op, a, b) => op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b;

export function matchIssue(i, terms, env) {
  for (const t of terms) { if (match1(i, t, env) === t.neg) return false; }
  return true;
}
function match1(i, t, env) {
  const v = t.value, l = v.toLowerCase();
  switch (t.field) {
    case null: return i.title.toLowerCase().includes(l) || (i.description || '').toLowerCase().includes(l);
    case 'status': return i.status.toLowerCase() === l;
    case 'type': return i.type === l;
    case 'priority': return i.priority === l;
    case 'assignee':
      if (l === 'none') return !i.assigneeId;
      if (l === 'me') return i.assigneeId === env.user.id;
      return !!i.assigneeId && env.assigneeName(i)?.toLowerCase() === l;
    case 'label': return i.labels.some((x) => x.toLowerCase() === l);
    case 'sprint': {
      if (l === 'none') return !i.sprintId;
      if (!i.sprintId) return false;
      const s = env.sprint(i.sprintId);
      if (l === 'active') return s?.state === 'active';
      return i.sprintId === v || s?.name.toLowerCase() === l;
    }
    case 'is': return (env.catOf(i) === 'completed') === (l === 'resolved');
    case 'due': return !!i.dueDate && test(t.cmp.op, i.dueDate.slice(0, 10), t.cmp.arg);
    case 'points': return i.storyPoints != null && test(t.cmp.op, i.storyPoints, t.cmp.arg);
    case 'key': return i.key.toLowerCase() === l;
  }
  return false;
}

const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const err = (m) => Object.assign(new Error(m), { status: 400, code: 'validation_error' });

export function parseQuery(q) {
  const terms = []; let i = 0; const n = q.length;
  const readValue = () => { // quoted or bare
    if (q[i] === '"') {
      let j = i + 1, s = '';
      while (j < n && q[j] !== '"') s += q[j++];
      if (j >= n) throw err('unterminated quote');
      i = j + 1; return { v: s, quoted: true };
    }
    let s = ''; while (i < n && !/\s/.test(q[i])) { if (q[i] === '"') throw err('unexpected quote'); s += q[i++]; }
    return { v: s, quoted: false };
  };
  while (i < n) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= n || /\s/.test(q[i])) throw err('dangling negation'); }
    const m = /^([A-Za-z]+):/.exec(q.slice(i));
    if (m && FIELDS.has(m[1].toLowerCase())) {
      const field = m[1].toLowerCase(); i += m[0].length;
      if (i >= n || /\s/.test(q[i])) throw err(`missing value for ${field}`);
      const { v } = readValue();
      if (v === '') throw err(`missing value for ${field}`);
      terms.push({ neg, ...compile(field, v) });
    } else {
      const { v, quoted } = readValue();
      if (!quoted && /^[A-Za-z]+:$/.test(v)) throw err('unknown or empty field');
      if (!quoted && /^[A-Za-z]+:/.test(v) && !/^[A-Za-z]+:\/\//.test(v)) throw err(`unknown field "${v.split(':')[0]}"`);
      if (v === '') throw err('empty term');
      terms.push({ neg, field: 'text', text: v.toLowerCase() });
    }
  }
  return terms;
}

function cmp(v, label) {
  const m = /^(<=|>=|<|>|=)?(.+)$/.exec(v);
  return { op: m[1] || '=', val: m[2] };
}
function compile(field, v) {
  const lv = v.toLowerCase();
  switch (field) {
    case 'type': if (!TYPES.includes(lv)) throw err('invalid type'); return { field, v: lv };
    case 'priority': if (!PRIOS.includes(lv)) throw err('invalid priority'); return { field, v: lv };
    case 'is': if (!['open', 'resolved'].includes(lv)) throw err('invalid is: value'); return { field, v: lv };
    case 'due': {
      const { op, val } = cmp(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val) || isNaN(Date.parse(val))) throw err('invalid date');
      return { field, op, val };
    }
    case 'points': {
      const { op, val } = cmp(v);
      if (!/^\d+(\.\d+)?$/.test(val)) throw err('invalid points');
      return { field, op, val: Number(val) };
    }
    default: return { field, v, lv };
  }
}
const test = (op, a, b) => op === '=' ? a === b : op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;

export function matchIssue(terms, i, ctx) {
  for (const t of terms) { if (matchTerm(t, i, ctx) === !!t.neg) return false; }
  return true;
}
function matchTerm(t, i, { user, S, catOf, projects }) {
  switch (t.field) {
    case 'text': return i.title.toLowerCase().includes(t.text) || (i.description || '').toLowerCase().includes(t.text);
    case 'status': return i.status.toLowerCase() === t.lv;
    case 'type': return i.type === t.v;
    case 'priority': return i.priority === t.v;
    case 'assignee': {
      if (t.lv === 'none') return !i.assigneeId;
      if (!i.assigneeId) return false;
      const name = t.lv === 'me' ? user.username.toLowerCase() : t.lv;
      return S.users[i.assigneeId]?.username.toLowerCase() === name;
    }
    case 'label': return i.labels.some((l) => l.toLowerCase() === t.lv);
    case 'sprint': {
      if (t.lv === 'none') return !i.sprintId;
      if (!i.sprintId) return false;
      const sp = S.sprints[i.sprintId];
      if (t.lv === 'active') return sp?.state === 'active';
      return i.sprintId === t.v || sp?.name.toLowerCase() === t.lv;
    }
    case 'is': { const done = !!i.resolvedAt; return t.v === 'resolved' ? done : !done; }
    case 'due': return !!i.dueDate && test(t.op, i.dueDate.slice(0, 10), t.val);
    case 'points': return i.storyPoints != null && test(t.op, i.storyPoints, t.val);
    case 'key': return i.key.toLowerCase() === t.lv;
  }
  return false;
}

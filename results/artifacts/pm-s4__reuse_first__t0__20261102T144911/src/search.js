// Search query language parser/evaluator (written from scratch).
const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const bad = (m) => Object.assign(new Error(m), { malformed: true });

export function parseQuery(q) {
  const terms = [];
  let i = 0;
  const n = q.length;
  while (i < n) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= n || /\s/.test(q[i])) throw bad('dangling "-"'); }
    let buf = '', inQ = false, quoted = false, colon = -1;
    while (i < n && (inQ || !/\s/.test(q[i]))) {
      const c = q[i];
      if (c === '"') { inQ = !inQ; quoted = true; }
      else { if (c === ':' && !inQ && colon < 0 && !quoted) colon = buf.length; buf += c; }
      i++;
    }
    if (inQ) throw bad('unterminated quote');
    if (colon >= 0) {
      const field = buf.slice(0, colon).toLowerCase();
      const value = buf.slice(colon + 1);
      if (!FIELDS.has(field)) throw bad(`unknown field "${field}"`);
      if (value === '') throw bad(`empty value for ${field}`);
      terms.push({ neg, field, ...checkValue(field, value) });
    } else {
      if (buf === '' ) throw bad('empty term');
      terms.push({ neg, text: buf.toLowerCase() });
    }
  }
  return terms;
}

function checkValue(field, value) {
  const v = value;
  switch (field) {
    case 'type': if (!TYPES.includes(v.toLowerCase())) throw bad('bad type'); return { value: v.toLowerCase() };
    case 'priority': if (!PRIOS.includes(v.toLowerCase())) throw bad('bad priority'); return { value: v.toLowerCase() };
    case 'is': if (!['open', 'resolved'].includes(v.toLowerCase())) throw bad('bad is:'); return { value: v.toLowerCase() };
    case 'due': {
      const m = /^(<=|>=|<|>|=)?(\d{4}-\d{2}-\d{2}|none)$/.exec(v);
      if (!m) throw bad('bad due');
      if (m[2] !== 'none' && isNaN(Date.parse(m[2]))) throw bad('bad date');
      return { op: m[1] || '=', value: m[2] };
    }
    case 'points': {
      const m = /^(<=|>=|<|>|=)?(\d+(?:\.\d+)?|none)$/.exec(v);
      if (!m) throw bad('bad points');
      return { op: m[1] || '=', value: m[2] === 'none' ? 'none' : Number(m[2]) };
    }
    default: return { value: v };
  }
}

const cmp = (a, op, b) => op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b;

// ctx: { userId, usernameOf(id), sprintOf(id), categoryOf(issue) }
export function matches(issue, terms, ctx) {
  for (const t of terms) {
    let ok;
    if (t.text !== undefined) {
      ok = issue.title.toLowerCase().includes(t.text) || (issue.description || '').toLowerCase().includes(t.text);
    } else {
      const v = t.value;
      switch (t.field) {
        case 'status': ok = issue.status.toLowerCase() === v.toLowerCase(); break;
        case 'type': ok = issue.type === v; break;
        case 'priority': ok = issue.priority === v; break;
        case 'assignee':
          if (v === 'none') ok = !issue.assigneeId;
          else if (v === 'me') ok = !!issue.assigneeId && issue.assigneeId === ctx.userId;
          else ok = !!issue.assigneeId && (ctx.usernameOf(issue.assigneeId) || '').toLowerCase() === v.toLowerCase();
          break;
        case 'label': ok = issue.labels.some((l) => l.toLowerCase() === v.toLowerCase()); break;
        case 'sprint': {
          const sp = issue.sprintId ? ctx.sprintOf(issue.sprintId) : null;
          if (v === 'none') ok = !issue.sprintId;
          else if (v === 'active') ok = !!sp && sp.state === 'active';
          else ok = !!sp && (sp.id === v || sp.name.toLowerCase() === v.toLowerCase());
          break;
        }
        case 'is': { const done = ctx.categoryOf(issue) === 'completed'; ok = v === 'open' ? !done : done; break; }
        case 'due':
          if (v === 'none') ok = !issue.dueDate; else ok = !!issue.dueDate && cmp(issue.dueDate, t.op, v);
          break;
        case 'points':
          if (v === 'none') ok = issue.storyPoints === null || issue.storyPoints === undefined;
          else ok = typeof issue.storyPoints === 'number' && cmp(issue.storyPoints, t.op, v);
          break;
        case 'key': ok = issue.key.toLowerCase() === v.toLowerCase(); break;
      }
    }
    if (t.neg ? ok : !ok) return false;
  }
  return true;
}

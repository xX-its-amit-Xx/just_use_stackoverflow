import { ISSUE_TYPES, PRIORITIES } from './util.js';

// Tokenises the search query language. Throws Error on malformed input.
export function parseQuery(q) {
  const s = String(q);
  const n = s.length;
  const ws = (c) => /\s/.test(c);
  const terms = [];
  const readQuoted = (start) => {
    const end = s.indexOf('"', start + 1);
    if (end < 0) throw new Error('unterminated quoted phrase');
    return [s.slice(start + 1, end), end + 1];
  };
  let i = 0;
  while (i < n) {
    if (ws(s[i])) {
      i++;
      continue;
    }
    let neg = false;
    if (s[i] === '-' && i + 1 < n && !ws(s[i + 1])) {
      neg = true;
      i++;
    }
    if (s[i] === '"') {
      const [v, e] = readQuoted(i);
      if (!v.trim()) throw new Error('empty phrase');
      terms.push({ neg, field: null, value: v });
      i = e;
      continue;
    }
    let j = i;
    while (j < n && !ws(s[j]) && s[j] !== ':') j++;
    if (j < n && s[j] === ':') {
      const field = s.slice(i, j).toLowerCase();
      let value;
      let e;
      if (s[j + 1] === '"') {
        [value, e] = readQuoted(j + 1);
      } else {
        let k = j + 1;
        while (k < n && !ws(s[k])) k++;
        value = s.slice(j + 1, k);
        e = k;
      }
      if (!value) throw new Error(`empty value for ${field}`);
      terms.push({ neg, field, value });
      i = e;
      continue;
    }
    let k = i;
    while (k < n && !ws(s[k])) k++;
    terms.push({ neg, field: null, value: s.slice(i, k) });
    i = k;
  }
  return terms;
}

const cmp = (a, op, b) => {
  switch (op) {
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    default: return a === b;
  }
};

// ctx: { user, isDone(issue), usernameOf(userId), activeSprintId(projectId) }
function compileOne(t) {
  const v = t.value;
  const lv = v.toLowerCase();
  if (t.field === null) {
    return (issue) => `${issue.title}\n${issue.description || ''}`.toLowerCase().includes(lv);
  }
  switch (t.field) {
    case 'status':
      return (i) => i.status.toLowerCase() === lv;
    case 'type':
      if (!ISSUE_TYPES.includes(lv)) throw new Error('invalid type');
      return (i) => i.type === lv;
    case 'priority':
      if (!PRIORITIES.includes(lv)) throw new Error('invalid priority');
      return (i) => i.priority === lv;
    case 'assignee':
      if (lv === 'me') return (i, c) => i.assigneeId === c.user.id;
      if (lv === 'none') return (i) => i.assigneeId == null;
      return (i, c) => (c.usernameOf(i.assigneeId) || '').toLowerCase() === lv;
    case 'label':
      return (i) => i.labels.some((l) => l.toLowerCase() === lv);
    case 'sprint':
      if (lv === 'active') return (i, c) => i.sprintId != null && c.activeSprintId(i.projectId) === i.sprintId;
      if (lv === 'none') return (i) => i.sprintId == null;
      return (i) => i.sprintId === v;
    case 'is':
      if (lv === 'open') return (i, c) => !c.isDone(i);
      if (lv === 'resolved') return (i, c) => c.isDone(i);
      throw new Error('is: must be open or resolved');
    case 'due': {
      const m = /^(<|>)?(\d{4}-\d{2}-\d{2})$/.exec(v);
      if (!m) throw new Error('invalid due date');
      const op = m[1] || '=';
      const d = m[2];
      return (i) => i.dueDate != null && cmp(i.dueDate, op, d);
    }
    case 'points': {
      const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)$/.exec(v);
      if (!m) throw new Error('invalid points');
      const op = m[1] || '=';
      const num = Number(m[2]);
      return (i) => i.storyPoints != null && cmp(i.storyPoints, op, num);
    }
    case 'key': {
      if (!/^[A-Za-z]{2,10}-\d+$/.test(v)) throw new Error('invalid key');
      const ku = v.toUpperCase();
      return (i) => i.key === ku;
    }
    default:
      throw new Error(`unknown field: ${t.field}`);
  }
}

export function compileTerms(terms) {
  return terms.map((t) => {
    const p = compileOne(t);
    return t.neg ? (i, c) => !p(i, c) : p;
  });
}

import { ISSUE_TYPES, PRIORITIES, bad, isValidDate } from './util.js';

const QUALIFIERS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);

function parseQualifier(field, value) {
  switch (field) {
    case 'status':
      return { field, value: value.toLowerCase() };
    case 'type': {
      const v = value.toLowerCase();
      if (!ISSUE_TYPES.includes(v)) throw bad(`invalid type "${value}"`);
      return { field, value: v };
    }
    case 'priority': {
      const v = value.toLowerCase();
      if (!PRIORITIES.includes(v)) throw bad(`invalid priority "${value}"`);
      return { field, value: v };
    }
    case 'assignee':
      return { field, value: value.toLowerCase() };
    case 'label':
      return { field, value: value.toLowerCase() };
    case 'sprint':
      return { field, value };
    case 'is': {
      const v = value.toLowerCase();
      if (v !== 'open' && v !== 'resolved') throw bad(`invalid is:"${value}"`);
      return { field, value: v };
    }
    case 'due': {
      const m = /^(<=|>=|<|>|=)?(.+)$/.exec(value);
      if (!isValidDate(m[2])) throw bad(`invalid due date "${value}"`);
      return { field, op: m[1] || '=', value: m[2] };
    }
    case 'points': {
      const m = /^(<=|>=|<|>|=)?(\d+(?:\.\d+)?)$/.exec(value);
      if (!m) throw bad(`invalid points "${value}"`);
      return { field, op: m[1] || '=', value: Number(m[2]) };
    }
    case 'key': {
      const v = value.toUpperCase();
      if (!/^[A-Z]{2,10}-\d+$/.test(v)) throw bad(`invalid key "${value}"`);
      return { field, value: v };
    }
    default:
      throw bad(`unknown qualifier "${field}"`);
  }
}

// Parses the search query language into a list of terms. Throws ApiError 400 when malformed.
export function parseQuery(q) {
  const terms = [];
  const s = String(q ?? '');
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let neg = false;
    if (s[i] === '-' && i + 1 < s.length && !/\s/.test(s[i + 1])) { neg = true; i++; }
    let buf = '';
    let inQuote = false;
    const startsQuoted = s[i] === '"';
    while (i < s.length) {
      const c = s[i];
      if (c === '"') { inQuote = !inQuote; i++; continue; }
      if (!inQuote && /\s/.test(c)) break;
      buf += c;
      i++;
    }
    if (inQuote) throw bad('unterminated quote in query');
    const m = startsQuoted ? null : /^([A-Za-z]+):(.*)$/.exec(buf);
    if (m) {
      const field = m[1].toLowerCase();
      if (!QUALIFIERS.has(field)) throw bad(`unknown qualifier "${m[1]}"`);
      if (m[2] === '') throw bad(`empty value for "${field}"`);
      terms.push({ neg, ...parseQualifier(field, m[2]) });
    } else if (buf !== '') {
      terms.push({ neg, field: 'text', value: buf.toLowerCase() });
    }
  }
  return terms;
}

const cmp = (a, op, b) => {
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: return a === b;
  }
};

// env: { userId, done(issue) -> bool, usernameOf(userId), activeSprintId(projectId) }
function testTerm(t, issue, env) {
  switch (t.field) {
    case 'text':
      return issue.title.toLowerCase().includes(t.value) ||
        (issue.description || '').toLowerCase().includes(t.value);
    case 'status':
      return issue.status.toLowerCase() === t.value;
    case 'type':
      return issue.type === t.value;
    case 'priority':
      return issue.priority === t.value;
    case 'assignee':
      if (t.value === 'none') return !issue.assigneeId;
      if (t.value === 'me') return issue.assigneeId === env.userId;
      return !!issue.assigneeId && String(env.usernameOf(issue.assigneeId) || '').toLowerCase() === t.value;
    case 'label':
      return issue.labels.some((l) => l.toLowerCase() === t.value);
    case 'sprint':
      if (t.value === 'none') return !issue.sprintId;
      if (t.value === 'active') return !!issue.sprintId && issue.sprintId === env.activeSprintId(issue.projectId);
      return issue.sprintId === t.value;
    case 'is':
      return t.value === 'resolved' ? env.done(issue) : !env.done(issue);
    case 'due':
      return !!issue.dueDate && cmp(issue.dueDate, t.op, t.value);
    case 'points':
      return issue.storyPoints !== null && issue.storyPoints !== undefined && cmp(issue.storyPoints, t.op, t.value);
    case 'key':
      return issue.key.toUpperCase() === t.value;
    default:
      return false;
  }
}

export function matchesAll(terms, issue, env) {
  return terms.every((t) => {
    const r = testTerm(t, issue, env);
    return t.neg ? !r : r;
  });
}

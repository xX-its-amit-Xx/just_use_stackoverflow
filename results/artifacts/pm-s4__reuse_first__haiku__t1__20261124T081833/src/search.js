// Search query language (SPEC §6).
// The quoted-token regex (TOKEN_RE) is adapted from search-query-parser by retraceio
// (MIT, Copyright (c) 2014 retraceio); see THIRD_PARTY_NOTICES.md and PROVENANCE.json.
import { bad } from './util.js';

export const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const KEYS = ['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key'];
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIORITIES = Object.keys(PRIORITY_RANK);

const TOKEN_RE = /(-?[A-Za-z_]+:'(?:[^'\\]|\\.)*')|(-?[A-Za-z_]+:"(?:[^"\\]|\\.)*")|(-?"(?:[^"\\]|\\.)*")|(-?'(?:[^'\\]|\\.)*')|(-?[A-Za-z_]+:\S*)|(\S+)/g;

function unquote(v) {
  const inner = v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1) : v;
  return inner.replace(/\\(.)/g, '$1');
}

export function parseQuery(q) {
  const s = String(q ?? '');
  const terms = [];
  const re = new RegExp(TOKEN_RE.source, 'g');
  let pos = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (s.slice(pos, m.index).trim()) throw bad('malformed query');
    // A quoted token must be followed by whitespace or end of input (e.g. "a"b is malformed).
    if (pos > 0 && m.index === pos) throw bad('malformed query: terms must be separated by whitespace');
    pos = re.lastIndex;
    let tok = m[0];
    let neg = false;
    if (tok.length > 1 && tok[0] === '-') {
      neg = true;
      tok = tok.slice(1);
    }
    const quotedValue = Boolean(m[1] || m[2]);
    const quotedText = Boolean(m[3] || m[4]);
    const kv = /^([A-Za-z_]+):([\s\S]*)$/.exec(tok);
    if (kv) {
      const key = kv[1].toLowerCase();
      if (!KEYS.includes(key)) throw bad(`unknown search key: ${kv[1]}`);
      let value = kv[2];
      if (/^["']/.test(value) && !quotedValue) throw bad('unterminated quote in query');
      if (quotedValue) value = unquote(value);
      if (!value) throw bad(`empty value for ${key}`);
      terms.push(validateTerm({ neg, key, value }));
    } else {
      if (/^["']/.test(tok) && !quotedText) throw bad('unterminated quote in query');
      const value = quotedText ? unquote(tok) : tok;
      if (!value) continue;
      terms.push({ neg, key: null, value });
    }
  }
  if (s.slice(pos).trim()) throw bad('malformed query');
  return terms;
}

function validateTerm(t) {
  switch (t.key) {
    case 'type':
      if (!TYPES.includes(t.value.toLowerCase())) throw bad(`invalid type: ${t.value}`);
      t.value = t.value.toLowerCase();
      break;
    case 'priority':
      if (!PRIORITIES.includes(t.value.toLowerCase())) throw bad(`invalid priority: ${t.value}`);
      t.value = t.value.toLowerCase();
      break;
    case 'is':
      if (!['open', 'resolved'].includes(t.value.toLowerCase())) throw bad(`invalid is: ${t.value}`);
      t.value = t.value.toLowerCase();
      break;
    case 'due': {
      const m = /^(<=|>=|<|>)?(\d{4}-\d{2}-\d{2})$/.exec(t.value);
      if (!m || Number.isNaN(Date.parse(m[2]))) throw bad(`invalid due date: ${t.value}`);
      t.op = m[1] || '=';
      t.value = m[2];
      break;
    }
    case 'points': {
      const m = /^(<=|>=|<|>|=)?(\d+(?:\.\d+)?)$/.exec(t.value);
      if (!m) throw bad(`invalid points: ${t.value}`);
      t.op = m[1] || '=';
      t.value = Number(m[2]);
      break;
    }
    default:
      break;
  }
  return t;
}

const cmp = (op, a, b) => {
  switch (op) {
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    default: return a === b;
  }
};

// ctx: { me, userIdByName(name) -> id|null, activeSprintIds(projectId) -> ids, isDone(issue) -> bool }
function termMatches(t, issue, ctx) {
  const lower = (x) => String(x ?? '').toLowerCase();
  switch (t.key) {
    case null: {
      const needle = t.value.toLowerCase();
      return lower(issue.title).includes(needle) || lower(issue.description).includes(needle);
    }
    case 'status': return lower(issue.status) === lower(t.value);
    case 'type': return issue.type === t.value;
    case 'priority': return issue.priority === t.value;
    case 'assignee':
      if (t.value.toLowerCase() === 'me') return issue.assigneeId === ctx.me;
      if (t.value.toLowerCase() === 'none') return !issue.assigneeId;
      return Boolean(issue.assigneeId) && issue.assigneeId === ctx.userIdByName(t.value);
    case 'label': return (issue.labels || []).some((l) => lower(l) === lower(t.value));
    case 'sprint':
      if (t.value.toLowerCase() === 'active') return Boolean(issue.sprintId) && ctx.activeSprintIds(issue.projectId).includes(issue.sprintId);
      if (t.value.toLowerCase() === 'none') return !issue.sprintId;
      return issue.sprintId === t.value;
    case 'is': return t.value === 'open' ? !ctx.isDone(issue) : ctx.isDone(issue);
    case 'due': return Boolean(issue.dueDate) && cmp(t.op, issue.dueDate, t.value);
    case 'points': return issue.storyPoints != null && cmp(t.op, issue.storyPoints, t.value);
    case 'key': return issue.key === t.value.toUpperCase();
    default: return false;
  }
}

export function matchIssue(terms, issue, ctx) {
  return terms.every((t) => termMatches(t, issue, ctx) !== t.neg);
}

export function sortIssues(list, sort = 'updated') {
  const copy = [...list];
  if (sort === 'created') return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (sort === 'priority') {
    return copy.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updatedAt.localeCompare(a.updatedAt));
  }
  return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

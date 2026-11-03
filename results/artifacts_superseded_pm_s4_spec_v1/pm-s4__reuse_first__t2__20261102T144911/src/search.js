import { ApiError } from './errors.js';
const bad = (m) => new ApiError(400, 'validation_error', m);
const FIELDS = new Set(['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key']);
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];

export function parseQuery(q) {
  const terms = []; let i = 0; const n = q.length;
  const readQuoted = () => {
    i++; let s = '';
    while (i < n && q[i] !== '"') { if (q[i] === '\\' && i + 1 < n) i++; s += q[i++]; }
    if (i >= n) throw bad('unterminated quote');
    i++; return s;
  };
  while (i < n) {
    if (/\s/.test(q[i])) { i++; continue; }
    let neg = false;
    if (q[i] === '-') { neg = true; i++; if (i >= n || /\s/.test(q[i])) throw bad('dangling negation'); }
    if (q[i] === '"') {
      const s = readQuoted(); if (!s) throw bad('empty phrase');
      terms.push({ field: null, value: s, neg }); continue;
    }
    const m = /^([A-Za-z]+):/.exec(q.slice(i));
    if (m) {
      const field = m[1].toLowerCase(); i += m[0].length;
      if (!FIELDS.has(field)) throw bad(`unknown field ${field}`);
      let v;
      if (q[i] === '"') v = readQuoted();
      else { const st = i; while (i < n && !/\s/.test(q[i])) i++; v = q.slice(st, i); }
      if (!v) throw bad(`missing value for ${field}`);
      const t = { field, value: v, neg };
      if (field === 'due' || field === 'points') {
        const mm = /^(<=|>=|<|>|=)?(.+)$/.exec(v); t.op = mm[1] || '='; t.value = mm[2];
        if (field === 'due' && !/^\d{4}-\d{2}-\d{2}$/.test(t.value)) throw bad('invalid date');
        if (field === 'points' && (t.value.trim() === '' || !isFinite(Number(t.value)))) throw bad('invalid number');
      }
      if (field === 'type' && !TYPES.includes(v)) throw bad('invalid type');
      if (field === 'priority' && !PRIOS.includes(v)) throw bad('invalid priority');
      if (field === 'is' && !['open', 'resolved'].includes(v)) throw bad('invalid is: value');
      terms.push(t); continue;
    }
    const st = i; while (i < n && !/\s/.test(q[i])) i++;
    const w = q.slice(st, i);
    if (w.includes('"')) throw bad('malformed query');
    terms.push({ field: null, value: w, neg });
  }
  return terms;
}

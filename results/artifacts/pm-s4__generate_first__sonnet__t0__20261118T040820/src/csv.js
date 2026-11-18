export function toCsv(rows) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
// returns [{rec: string[], line}] where line is the 1-based line where the record starts
export function parseCsv(text) {
  const out = []; let rec = [], f = '', q = false, line = 1, start = 1, i = 0, any = false;
  const endRec = () => { rec.push(f); out.push({ rec, line: start }); rec = []; f = ''; any = false; };
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
      if (ch === '\n') line++;
      f += ch; i++; continue;
    }
    if (ch === '"' && f === '') { q = true; any = true; i++; continue; }
    if (ch === ',') { rec.push(f); f = ''; any = true; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++; endRec(); line++; start = line; continue;
    }
    f += ch; any = true; i++;
  }
  if (q) throw new Error('unterminated quoted field');
  if (any || f !== '' || rec.length) endRec();
  return out;
}

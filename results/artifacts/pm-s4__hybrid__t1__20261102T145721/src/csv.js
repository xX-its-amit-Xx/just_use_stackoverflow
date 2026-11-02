// RFC 4180 CSV parse/serialize. Parse returns [{line, cells}] (line = 1-based start line).
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let cells = [], cur = '', inQ = false, line = 1, start = 1, i = 0, any = false;
  const endRow = () => { cells.push(cur); cur = ''; if (any || cells.length > 1 || cells[0] !== '') rows.push({ line: start, cells }); cells = []; any = false; };
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i += 2; continue; } inQ = false; i++; continue; }
      if (c === '\n') line++;
      cur += c; i++; continue;
    }
    if (c === '"' && cur === '') { inQ = true; any = true; i++; continue; }
    if (c === ',') { cells.push(cur); cur = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++; endRow(); line++; start = line; continue;
    }
    cur += c; i++;
  }
  if (inQ) { const e = new Error('unterminated quoted field'); e.line = start; throw e; }
  if (cur !== '' || cells.length || any) endRow();
  return rows;
}
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(rows) { return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

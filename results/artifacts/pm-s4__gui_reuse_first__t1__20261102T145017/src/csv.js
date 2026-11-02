// RFC 4180 CSV helpers
export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(rows) { return rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'; }
// returns [{line, fields}] ; line = 1-based line where record starts
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out = []; let f = '', row = [], q = false, line = 1, start = 1, i = 0, any = false;
  const endRow = () => { row.push(f); f = ''; if (!(row.length === 1 && row[0] === '' && !any)) out.push({ line: start, fields: row }); row = []; any = false; };
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else { if (c === '\n') line++; f += c; }
    } else if (c === '"') { q = true; any = true; }
    else if (c === ',') { row.push(f); f = ''; any = true; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { endRow(); line++; start = line; }
    else { f += c; any = true; }
  }
  if (q) throw new Error('unterminated quote');
  if (f !== '' || row.length || any) endRow();
  return out;
}

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(rows) { return rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'; }
// returns [{line, cells}] ; line = 1-based physical line where record starts
export function parseCsv(text) {
  const out = []; let row = [], cell = '', q = false, line = 1, start = 1, i = 0, any = false;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else { if (c === '\n') line++; cell += c; }
    } else if (c === '"' && cell === '') { q = true; any = true; }
    else if (c === ',') { row.push(cell); cell = ''; any = true; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (any || cell !== '' || row.length) { row.push(cell); out.push({ line: start, cells: row }); }
      row = []; cell = ''; any = false; line++; start = line;
    } else { cell += c; any = true; }
  }
  if (q) throw new Error('unterminated quote');
  if (any || cell !== '' || row.length) { row.push(cell); out.push({ line: start, cells: row }); }
  return out;
}

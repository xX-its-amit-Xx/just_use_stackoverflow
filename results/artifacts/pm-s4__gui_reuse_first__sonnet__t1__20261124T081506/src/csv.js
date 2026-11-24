// Minimal RFC 4180 CSV writer/parser (written from scratch).
export function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(rows) { return rows.map(r => r.map(csvField).join(',')).join('\r\n') + '\r\n'; }

// returns [{line, cells}]; line is 1-based line where record starts
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const out = [];
  let row = [], cell = '', inQ = false, line = 1, start = 1, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else { if (c === '\n') line++; cell += c; }
      continue;
    }
    if (c === '"' && cell === '') { inQ = true; any = true; }
    else if (c === ',') { row.push(cell); cell = ''; any = true; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (any || cell !== '' || row.length) { row.push(cell); out.push({ line: start, cells: row }); }
      row = []; cell = ''; any = false; line++; start = line;
    } else { cell += c; any = true; }
  }
  if (inQ) throw new Error('unterminated quote');
  if (any || cell !== '' || row.length) { row.push(cell); out.push({ line: start, cells: row }); }
  return out;
}

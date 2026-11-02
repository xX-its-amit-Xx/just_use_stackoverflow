export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(rows) { return rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'; }
// returns [{line, fields}] ; throws on unterminated quote
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out = []; let row = []; let f = ''; let q = false; let line = 1; let start = 1; let any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else { if (c === '\n') line++; f += c; }
    } else if (c === '"' && f === '') { q = true; any = true; }
    else if (c === ',') { row.push(f); f = ''; any = true; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (any || f !== '' || row.length) { row.push(f); out.push({ line: start, fields: row }); }
      row = []; f = ''; any = false; line++; start = line;
    } else { f += c; any = true; }
  }
  if (q) { const e = new Error('unterminated quoted field'); e.line = start; throw e; }
  if (any || f !== '' || row.length) { row.push(f); out.push({ line: start, fields: row }); }
  return out;
}

export function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(rows) { return rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'; }
// returns [{line, fields}]
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out = []; let row = [], field = '', q = false, line = 1, start = 1, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else { if (c === '\n') line++; field += c; }
      continue;
    }
    if (c === '"' && field === '') { q = true; any = true; }
    else if (c === ',') { row.push(field); field = ''; any = true; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (any || row.length > 1 || row[0] !== '') out.push({ line: start, fields: row });
      row = []; field = ''; any = false; line++; start = line;
    } else { field += c; any = true; }
  }
  if (q) { const e = new Error('unterminated quote'); e.line = start; throw e; }
  if (any || field !== '' || row.length) { row.push(field); out.push({ line: start, fields: row }); }
  return out;
}

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(rows) { return rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'; }
// returns [{line, cells}] ; throws on unterminated quote
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const recs = []; let cells = [], cur = '', q = false, line = 1, start = 1, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else { if (c === '\n') line++; cur += c; }
    } else if (c === '"' && cur === '') { q = true; any = true; }
    else if (c === ',') { cells.push(cur); cur = ''; any = true; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (any || cur !== '' || cells.length) { cells.push(cur); recs.push({ line: start, cells }); }
      cells = []; cur = ''; any = false; line++; start = line;
    } else { cur += c; any = true; }
  }
  if (q) throw new Error('unterminated quote');
  if (any || cur !== '' || cells.length) { cells.push(cur); recs.push({ line: start, cells }); }
  return recs;
}

export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCSV(rows) {
  return rows.map(r => r.map(csvEscape).join(',') + '\r\n').join('');
}
// Returns [{line, cells}] ; line is 1-based line number where the record starts. Throws on unterminated quote.
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out = [];
  let cells = [], cur = '', inQ = false, line = 1, startLine = 1, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else { if (c === '\n') line++; cur += c; }
      continue;
    }
    if (c === '"' && cur === '') { inQ = true; any = true; }
    else if (c === ',') { cells.push(cur); cur = ''; any = true; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (any || cur !== '' || cells.length) { cells.push(cur); out.push({ line: startLine, cells }); }
      cells = []; cur = ''; any = false; line++; startLine = line;
    } else { cur += c; any = true; }
  }
  if (inQ) throw new Error('unterminated quoted field');
  if (any || cur !== '' || cells.length) { cells.push(cur); out.push({ line: startLine, cells }); }
  return out;
}

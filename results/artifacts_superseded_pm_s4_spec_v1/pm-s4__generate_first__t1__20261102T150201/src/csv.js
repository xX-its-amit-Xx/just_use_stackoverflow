// RFC 4180 CSV helpers
export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(rows) { return rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'; }

// returns [{line, cells}] ; throws on unterminated quote
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let cells = []; let cur = ''; let inQ = false; let line = 1; let startLine = 1; let any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else { if (c === '\n') line++; cur += c; }
    } else if (c === '"' && cur === '') { inQ = true; any = true; }
    else if (c === ',') { cells.push(cur); cur = ''; any = true; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (any || cur !== '' || cells.length) { cells.push(cur); rows.push({ line: startLine, cells }); }
      cells = []; cur = ''; any = false; line++; startLine = line;
    } else { cur += c; any = true; }
  }
  if (inQ) throw new Error('unterminated quoted field');
  if (any || cur !== '' || cells.length) { cells.push(cur); rows.push({ line: startLine, cells }); }
  return rows;
}

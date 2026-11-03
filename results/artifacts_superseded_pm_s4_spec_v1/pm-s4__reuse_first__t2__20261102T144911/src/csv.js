// Minimal RFC 4180 CSV parser/serializer. Rows carry their starting line number.
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let f = []; let cur = ''; let q = false; let line = 1; let start = 1; let any = false;
  const endField = () => { f.push(cur); cur = ''; };
  const endRow = () => { endField(); if (!(f.length === 1 && f[0] === '' && !any)) rows.push({ line: start, fields: f }); f = []; any = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else { if (ch === '\n') line++; cur += ch; }
    } else if (ch === '"' && cur === '') { q = true; any = true; }
    else if (ch === ',') { any = true; endField(); }
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow(); line++; start = line;
    } else { any = true; cur += ch; }
  }
  if (cur !== '' || f.length || any) endRow();
  return rows;
}
const esc = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCsv = (rows) => rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';

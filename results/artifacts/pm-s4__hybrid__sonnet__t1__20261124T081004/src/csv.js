const esc = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCsv = (rows) => rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';

// returns [{fields, line}] where line is the 1-based starting line of the record
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out = []; let fields = [], cur = '', inQ = false, line = 1, start = 1, any = false;
  const endRec = () => { fields.push(cur); out.push({ fields, line: start }); fields = []; cur = ''; any = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else { if (c === '\n') line++; cur += c; }
    } else if (c === '"' && cur === '') { inQ = true; any = true; }
    else if (c === ',') { fields.push(cur); cur = ''; any = true; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (any || cur !== '' || fields.length) endRec(); 
      line++; start = line;
    } else { cur += c; any = true; }
  }
  if (inQ) throw new Error('unterminated quoted field');
  if (any || cur !== '' || fields.length) endRec();
  return out;
}

// RFC 4180 CSV parse/format (written from scratch for this project).
export function formatCsv(rows) {
  const q = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

// Returns [{line, fields}] ; throws Error on unterminated quote.
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out = [];
  let fields = [], cur = '', inQ = false, line = 1, start = 1, any = false;
  const endRec = () => {
    fields.push(cur);
    if (!(fields.length === 1 && fields[0] === '' && !any)) out.push({ line: start, fields });
    fields = []; cur = ''; any = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else { if (c === '\n') line++; cur += c; }
    } else if (c === '"' && cur === '') { inQ = true; any = true; }
    else if (c === ',') { fields.push(cur); cur = ''; any = true; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRec(); line++; start = line;
    } else { cur += c; any = true; }
  }
  if (inQ) throw new Error('unterminated quoted field');
  if (cur !== '' || fields.length || any) endRec();
  return out;
}

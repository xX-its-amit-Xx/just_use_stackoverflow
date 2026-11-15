// RFC 4180 CSV helpers.
export function toCsv(rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

// Returns [{ line, fields }] where line is the 1-based starting line of the record.
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out = [];
  let fields = []; let cur = ''; let inQ = false; let line = 1; let recLine = 1; let any = false;
  const endRec = () => {
    fields.push(cur);
    if (any || fields.length > 1 || fields[0] !== '') out.push({ line: recLine, fields });
    fields = []; cur = ''; any = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else { if (c === '\n') line++; cur += c; }
    } else if (c === '"') { inQ = true; any = true; }
    else if (c === ',') { fields.push(cur); cur = ''; any = true; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRec(); line++; recLine = line;
    } else { cur += c; any = true; }
  }
  if (cur !== '' || fields.length || any) endRec();
  return out;
}

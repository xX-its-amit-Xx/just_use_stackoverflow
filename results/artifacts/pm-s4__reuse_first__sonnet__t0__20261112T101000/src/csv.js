// CSV parsing adapted from Stack Overflow answer https://stackoverflow.com/a/41563966
// (CC BY-SA 4.0, "RFC 4180 solution"). Adapted: trailing-newline handling, blank-line
// skipping, line-number tracking, and handling of quotes in the middle of a field.
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let p = '', row = [''], ret = [row], i = 0, r = 0, s = true, line = 1;
  const lines = [1];
  for (let l of text) {
    if ('"' === l) {
      if (s && l === p) row[i] += l;
      s = !s;
    } else if (',' === l && s) l = row[++i] = '';
    else if ('\n' === l && s) {
      if ('\r' === p) row[i] = row[i].slice(0, -1);
      row = ret[++r] = [l = '']; i = 0; line++; lines[r] = line;
    } else { row[i] += l; if (l === '\n') line++; }
    p = l;
  }
  const out = [];
  ret.forEach((rw, idx) => {
    if (rw.length === 1 && rw[0] === '') return; // blank line
    out.push({ line: lines[idx], cells: rw });
  });
  return out;
}
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const csvLine = (arr) => arr.map(csvCell).join(',');

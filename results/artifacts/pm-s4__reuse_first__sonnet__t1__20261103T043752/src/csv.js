// CSV parsing adapted from Stack Overflow answer https://stackoverflow.com/a/1293163
// (Ben Nadel's CSVToArray, CC BY-SA). Adapted to ES module, with line tracking.
export function parseCSV(strData, strDelimiter = ',') {
  const objPattern = new RegExp(
    '(\\' + strDelimiter + '|\\r?\\n|\\r|^)' +
    '(?:"([^"]*(?:""[^"]*)*)"|' +
    '([^"\\' + strDelimiter + '\\r\\n]*))', 'gi');
  const arrData = [[]];
  let m;
  while ((m = objPattern.exec(strData))) {
    const d = m[1];
    if (d.length && d !== strDelimiter) arrData.push([]);
    const v = m[2] !== undefined ? m[2].replace(/""/g, '"') : m[3];
    arrData[arrData.length - 1].push(v);
    if (m[0].length === 0) objPattern.lastIndex++;
  }
  return arrData;
}
export function toCSV(rows) {
  const esc = v => { v = v == null ? '' : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return rows.map(r => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

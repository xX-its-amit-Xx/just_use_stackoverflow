import dsv from './vendor/dsv.js';
const d = dsv(',');
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return d.parseRows(text);
}
export function formatCsv(rows) { return rows.map(r => d.formatRow(r)).join('\r\n') + '\r\n'; }

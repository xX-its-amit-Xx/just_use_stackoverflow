// Minimal line diff (longest common subsequence). Inside each changed run,
// "-" lines come before "+" lines.

const splitLines = (text) => (text === "" ? [] : String(text).split("\n"));

/**
 * @param {string} fromText
 * @param {string} toText
 * @returns {{op: " " | "-" | "+", text: string}[]}
 */
export function diffLines(fromText, toText) {
  const a = splitLines(fromText);
  const b = splitLines(toText);

  // Trim the common prefix and suffix so the LCS table only covers the change.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ op: " ", text: a[i] });

  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const n = x.length;
  const m = y.length;
  // lcs[i][j] = LCS length of x[i..] and y[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  let pendingDel = [];
  let pendingAdd = [];
  const flush = () => {
    for (const t of pendingDel) ops.push({ op: "-", text: t });
    for (const t of pendingAdd) ops.push({ op: "+", text: t });
    pendingDel = [];
    pendingAdd = [];
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      flush();
      ops.push({ op: " ", text: x[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      pendingDel.push(x[i++]);
    } else {
      pendingAdd.push(y[j++]);
    }
  }
  while (i < n) pendingDel.push(x[i++]);
  while (j < m) pendingAdd.push(y[j++]);
  flush();

  for (let k = endA; k < a.length; k++) ops.push({ op: " ", text: a[k] });
  return ops;
}

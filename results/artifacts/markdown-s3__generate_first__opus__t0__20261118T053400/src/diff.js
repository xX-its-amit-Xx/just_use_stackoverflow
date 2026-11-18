// Minimal line diff based on longest common subsequence.
export function splitLines(s) {
  return s === '' ? [] : s.split('\n');
}

export function diffLines(aText, bText) {
  const a = splitLines(aText), b = splitLines(bText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const n = A.length, m = B.length;
  // L[i][j] = LCS length of A[i:], B[j:]
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const raw = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { raw.push({ op: ' ', text: A[i] }); i++; j++; }
    else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) { raw.push({ op: '-', text: A[i] }); i++; }
    else { raw.push({ op: '+', text: B[j] }); j++; }
  }
  // within each changed run, put all '-' before '+'
  const mid = [];
  let k = 0;
  while (k < raw.length) {
    if (raw[k].op === ' ') { mid.push(raw[k]); k++; continue; }
    const del = [], add = [];
    while (k < raw.length && raw[k].op !== ' ') { (raw[k].op === '-' ? del : add).push(raw[k]); k++; }
    mid.push(...del, ...add);
  }
  return [
    ...a.slice(0, pre).map((t) => ({ op: ' ', text: t })),
    ...mid,
    ...a.slice(a.length - suf).map((t) => ({ op: ' ', text: t })),
  ];
}

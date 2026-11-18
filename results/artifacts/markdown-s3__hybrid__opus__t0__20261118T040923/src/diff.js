// Minimal line-based diff using an LCS table (common prefix/suffix trimmed first).
function toLines(s) {
  return s === '' ? [] : String(s).split('\n');
}

export function diffLines(fromText, toText) {
  const a = toLines(fromText), b = toLines(toText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const n = A.length, m = B.length;
  const W = m + 1;
  const L = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
  }
  const mid = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { mid.push({ op: ' ', text: A[i] }); i++; j++; }
    else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { mid.push({ op: '-', text: A[i++] }); }
    else { mid.push({ op: '+', text: B[j++] }); }
  }
  while (i < n) mid.push({ op: '-', text: A[i++] });
  while (j < m) mid.push({ op: '+', text: B[j++] });
  // within each changed run, put all deletions before insertions
  const out = a.slice(0, pre).map((text) => ({ op: ' ', text }));
  for (let k = 0; k < mid.length;) {
    if (mid[k].op === ' ') { out.push(mid[k++]); continue; }
    const dels = [], adds = [];
    while (k < mid.length && mid[k].op !== ' ') (mid[k].op === '-' ? dels : adds).push(mid[k++]);
    out.push(...dels, ...adds);
  }
  for (const text of a.slice(a.length - suf)) out.push({ op: ' ', text });
  return out;
}

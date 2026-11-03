// Minimal line-based diff using an LCS table. Within each changed run, all
// "-" lines are emitted before "+" lines.
function splitLines(s) {
  if (s === '' || s == null) return [];
  return String(s).split('\n');
}

export function diffLines(a, b) {
  const A = splitLines(a);
  const B = splitLines(b);
  // trim common prefix / suffix to keep the table small
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const n = a2.length;
  const m = b2.length;
  const w = m + 1;
  const L = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = a2[i] === b2[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const out = A.slice(0, pre).map((text) => ({ op: ' ', text }));
  let dels = [];
  let adds = [];
  const flush = () => {
    for (const text of dels) out.push({ op: '-', text });
    for (const text of adds) out.push({ op: '+', text });
    dels = [];
    adds = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a2[i] === b2[j]) {
      flush();
      out.push({ op: ' ', text: a2[i] });
      i++;
      j++;
    } else if (j >= m || (i < n && L[(i + 1) * w + j] >= L[i * w + j + 1])) {
      dels.push(a2[i++]);
    } else {
      adds.push(b2[j++]);
    }
  }
  flush();
  for (const text of A.slice(A.length - suf)) out.push({ op: ' ', text });
  return out;
}

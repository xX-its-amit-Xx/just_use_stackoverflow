// Minimal line-based diff using a longest-common-subsequence table.
function splitLines(s) {
  if (s === '') return [];
  const lines = String(s).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function lineDiff(fromText, toText) {
  const a = splitLines(fromText), b = splitLines(toText);
  // trim common prefix/suffix to keep the table small
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const n = A.length, m = B.length;
  // dp[i][j] = LCS length of A[i:] and B[j:]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = a.slice(0, pre).map((text) => ({ op: ' ', text }));
  let i = 0, j = 0, dels = [], adds = [];
  const flush = () => { out.push(...dels, ...adds); dels = []; adds = []; };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j] && dp[i][j] === dp[i + 1][j + 1] + 1) {
      flush(); out.push({ op: ' ', text: A[i] }); i++; j++;
    } else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) {
      dels.push({ op: '-', text: A[i++] });
    } else {
      adds.push({ op: '+', text: B[j++] });
    }
  }
  flush();
  for (const text of a.slice(a.length - suf)) out.push({ op: ' ', text });
  return out;
}

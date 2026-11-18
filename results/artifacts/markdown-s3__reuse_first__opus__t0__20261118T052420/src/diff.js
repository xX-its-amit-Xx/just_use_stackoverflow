// Minimal line-based diff via classic LCS dynamic programming.
export function lineDiff(fromText, toText) {
  const a = fromText === '' ? [] : String(fromText).split('\n');
  const b = toText === '' ? [] : String(toText).split('\n');
  const n = a.length, m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0, dels = [], adds = [];
  const flush = () => { for (const t of dels) out.push({ op: '-', text: t }); for (const t of adds) out.push({ op: '+', text: t }); dels = []; adds = []; };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) { dels.push(a[i++]); }
    else { adds.push(b[j++]); }
  }
  flush();
  return out;
}

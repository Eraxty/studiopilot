// Line diff for script changes: trims the common head/tail, then an LCS on
// the middle. Returns unified-diff hunks with 3 lines of context.
(function () {
  function lcsDiff(a, b) {
    const n = a.length, m = b.length;
    if (n * m > 4e6) return null; // too big to diff here
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a[i++]]);
      else ops.push(['+', b[j++]]);
    }
    while (i < n) ops.push(['-', a[i++]]);
    while (j < m) ops.push(['+', b[j++]]);
    return ops;
  }

  function diffLines(before, after) {
    const a = (before || '').split('\n');
    const b = (after || '').split('\n');
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const mid = lcsDiff(a.slice(head, a.length - tail), b.slice(head, b.length - tail));
    const ops = [
      ...a.slice(0, head).map((l) => [' ', l]),
      ...(mid || [...a.slice(head, a.length - tail).map((l) => ['-', l]), ...b.slice(head, b.length - tail).map((l) => ['+', l])]),
      ...a.slice(a.length - tail).map((l) => [' ', l]),
    ];
    let added = 0, removed = 0;
    for (const [t] of ops) { if (t === '+') added++; else if (t === '-') removed++; }

    // collapse unchanged runs into hunks
    const out = [];
    const ctx = 3;
    let oldLine = 1, newLine = 1, lastShown = -1;
    ops.forEach(([t], idx) => {
      const near = ops.slice(Math.max(0, idx - ctx), idx + ctx + 1).some(([k]) => k !== ' ');
      if (t !== ' ' || near) {
        if (idx !== lastShown + 1) out.push(['@', `@@ line ${t === '+' ? newLine : oldLine} @@`]);
        out.push([t, ops[idx][1]]);
        lastShown = idx;
      }
      if (t !== '+') oldLine++;
      if (t !== '-') newLine++;
    });
    return { lines: out, added, removed };
  }

  window.spDiff = { diffLines };
})();

/**
 * Line diff for confirmation previews (ADR-018): the owner approves exactly what will be written.
 * Common prefix and suffix are trimmed first; the middle uses an LCS table when it is small enough
 * and falls back to "remove all / add all" otherwise. Output is a unified diff with 2 lines of context.
 */

const CONTEXT = 2;
const MAX_CELLS = 4_000_000;

type Op = { kind: " " | "-" | "+"; line: string; a: number; b: number };

function ops(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const out: Op[] = [];
  for (let i = 0; i < pre; i++) out.push({ kind: " ", line: a[i] ?? "", a: i, b: i });

  if (am.length * bm.length <= MAX_CELLS && am.length && bm.length) {
    const n = am.length;
    const m = bm.length;
    const lcs = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] =
          am[i] === bm[j] ? (lcs[(i + 1) * (m + 1) + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * (m + 1) + j] ?? 0, lcs[i * (m + 1) + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        out.push({ kind: " ", line: am[i] ?? "", a: pre + i, b: pre + j });
        i++;
        j++;
      } else if (i < n && (j === m || (lcs[(i + 1) * (m + 1) + j] ?? 0) >= (lcs[i * (m + 1) + j + 1] ?? 0))) {
        out.push({ kind: "-", line: am[i] ?? "", a: pre + i, b: pre + j }); // removals first, like git
        i++;
      } else {
        out.push({ kind: "+", line: bm[j] ?? "", a: pre + i, b: pre + j });
        j++;
      }
    }
  } else {
    am.forEach((line, i) => out.push({ kind: "-", line, a: pre + i, b: pre }));
    bm.forEach((line, j) => out.push({ kind: "+", line, a: pre + am.length, b: pre + j }));
  }

  for (let k = 0; k < suf; k++) {
    out.push({ kind: " ", line: a[a.length - suf + k] ?? "", a: a.length - suf + k, b: b.length - suf + k });
  }
  return out;
}

export const splitLines = (text: string): string[] => (text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** Unified diff body (no file headers). Empty when both sides are equal. */
export function unifiedDiff(before: string, after: string): string {
  const list = ops(splitLines(before), splitLines(after));
  const changed = list.map((o, i) => (o.kind !== " " ? i : -1)).filter((i) => i >= 0);
  if (!changed.length) return "";
  const hunks: [number, number][] = [];
  for (const i of changed) {
    const last = hunks[hunks.length - 1];
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(list.length - 1, i + CONTEXT);
    if (last && from <= last[1] + 1) last[1] = to;
    else hunks.push([from, to]);
  }
  const out: string[] = [];
  for (const [from, to] of hunks) {
    const slice = list.slice(from, to + 1);
    const first = slice[0] as Op;
    const aLen = slice.filter((o) => o.kind !== "+").length;
    const bLen = slice.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${first.a + 1},${aLen} +${first.b + 1},${bLen} @@`);
    for (const o of slice) out.push(`${o.kind}${o.line}`);
  }
  return out.join("\n");
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  const list = ops(splitLines(before), splitLines(after));
  return { added: list.filter((o) => o.kind === "+").length, removed: list.filter((o) => o.kind === "-").length };
}

/**
 * Line-level diff with hunk output for dsh-checkpoints.
 *
 * The stats route (`/diff`) only reports per-file +/− line counts; the file
 * comparison route (`/file-diff`) needs the actual changed lines. Both sides
 * (snapshot content vs workspace content) are read as text and diffed here
 * with Myers' O(ND) algorithm, so the result is provider-independent — git,
 * hybrid, and copy snapshots all produce the same hunk shape.
 *
 * Output mirrors the unified diff format: a list of hunks, each with
 * `@@ -oldStart,oldLines +newStart,newLines @@` numbers and the context /
 * added / removed lines it contains.
 */

/** One line inside a hunk. */
export interface DiffLine {
  readonly type: 'ctx' | 'add' | 'del'
  /** 1-based old-file line number (absent for pure additions). */
  readonly oldNum?: number
  /** 1-based new-file line number (absent for pure deletions). */
  readonly newNum?: number
  /** Line text without a trailing newline and without the +/- prefix. */
  readonly text: string
}

/** One unified-diff style hunk. */
export interface FileHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly DiffLine[]
}

export interface HunkDiffResult {
  readonly hunks: readonly FileHunk[]
  readonly additions: number
  readonly deletions: number
}

/** Context lines shown around each change cluster inside a hunk. */
const HUNK_CONTEXT = 3

/**
 * Myers search depth cap: beyond this many edits the exact alignment is
 * abandoned and the remaining middle is emitted as one coarse "all removed,
 * all added" hunk. Real code edits stay far below the cap; whole-file
 * rewrites degrade gracefully instead of stalling the request.
 */
const MAX_MYERS_D = 2000

/**
 * Middles larger than this many lines skip Myers entirely (the O((N+M)·D)
 * snake work would dominate) and use the coarse hunk directly.
 */
const MAX_MYERS_MIDDLE_LINES = 120_000

/**
 * Files whose text side exceeds this many characters are rejected upstream by
 * the route (flagged `tooLarge`) instead of being read into the differ.
 */
export const MAX_DIFF_TEXT_CHARS = 4 * 1024 * 1024

/** True when the text looks binary (a NUL byte within the first 8 KiB). */
export function looksBinary(text: string): boolean {
  const probe = text.length > 8192 ? text.slice(0, 8192) : text
  return probe.includes('\u0000')
}

/**
 * Split text into diff lines: the trailing newline does not create an extra
 * empty line, and trailing `\r` is stripped so CRLF/LF-only differences do
 * not paint the whole file as changed.
 */
export function splitDiffLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line !== undefined && line.endsWith('\r')) lines[i] = line.slice(0, -1)
  }
  return lines
}

/** Raw edit-script op over the full line arrays. 0 = context, 1 = delete, 2 = add. */
interface RawOp {
  readonly t: 0 | 1 | 2
  /** Index into the old lines (t = 0/1). */
  readonly a: number
  /** Index into the new lines (t = 0/2). */
  readonly b: number
}

/**
 * Myers shortest-edit-script with snapshot trace, over the full arrays.
 * Returns null when the edit distance exceeds MAX_MYERS_D (caller degrades).
 */
function myersOps(a: readonly string[], b: readonly string[]): RawOp[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  // v[k + offset] = furthest x on diagonal k; one extra cell of margin so the
  // k+1 / k-1 neighbour reads never leave the array.
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  v[offset + 1] = 0
  // trace[d] snapshots the k-range step d reads (k ∈ [-d, d+1]); index k → k + d.
  const trace: Int32Array[] = []
  const depthCap = Math.min(max, MAX_MYERS_D)
  let found = false
  for (let d = 0; d <= depthCap; d++) {
    trace.push(v.slice(offset - d, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) {
        x = v[k + 1 + offset]!
      } else {
        x = v[k - 1 + offset]! + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[k + offset] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
    if (found) break
  }
  if (!found) return null

  // Walk the trace backwards, turning the path into an ordered op list.
  const ops: RawOp[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!
    const k = x - y
    const down = k === -d || (k !== d && vd[k - 1 + d]! < vd[k + 1 + d]!)
    const prevK = down ? k + 1 : k - 1
    const prevX = vd[prevK + d]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ t: 0, a: x - 1, b: y - 1 })
      x -= 1
      y -= 1
    }
    if (d > 0) {
      if (x === prevX) ops.push({ t: 2, a: -1, b: prevY })
      else ops.push({ t: 1, a: prevX, b: -1 })
    }
    x = prevX
    y = prevY
  }
  ops.reverse()
  return ops
}

/** Coarse fallback: the whole middle becomes "remove old, add new". */
function coarseMiddleOps(start: number, endA: number, endB: number): RawOp[] {
  const ops: RawOp[] = []
  for (let i = start; i < endA; i++) ops.push({ t: 1, a: i, b: -1 })
  for (let j = start; j < endB; j++) ops.push({ t: 2, a: -1, b: j })
  return ops
}

/**
 * Full-array op list: the common prefix/suffix become context ops (so hunks
 * can show up to HUNK_CONTEXT edge context lines), the middle comes from
 * Myers or the coarse fallback.
 */
function fullOps(a: readonly string[], b: readonly string[]): RawOp[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const ops: RawOp[] = []
  for (let i = 0; i < start; i++) ops.push({ t: 0, a: i, b: i })

  const middleLines = (endA - start) + (endB - start)
  let middle: RawOp[] | null = null
  if (middleLines <= MAX_MYERS_MIDDLE_LINES) middle = myersOps(a.slice(start, endA), b.slice(start, endB))
  if (middle === null) {
    ops.push(...coarseMiddleOps(start, endA, endB))
  } else {
    for (const op of middle) {
      ops.push(op.t === 0
        ? { t: 0, a: op.a + start, b: op.b + start }
        : op.t === 1
          ? { t: 1, a: op.a + start, b: -1 }
          : { t: 2, a: -1, b: op.b + start })
    }
  }
  for (let j = 0; endA + j < a.length; j++) ops.push({ t: 0, a: endA + j, b: endB + j })
  return ops
}

/**
 * Compute unified-diff hunks between two texts. When the texts are equal the
 * result is an empty hunk list with zero counts.
 */
export function diffToHunks(oldText: string, newText: string): HunkDiffResult {
  const a = splitDiffLines(oldText)
  const b = splitDiffLines(newText)
  const ops = fullOps(a, b)

  let additions = 0
  let deletions = 0
  const changeIdx: number[] = []
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    if (op.t === 1) {
      deletions += 1
      changeIdx.push(i)
    } else if (op.t === 2) {
      additions += 1
      changeIdx.push(i)
    }
  }
  if (changeIdx.length === 0) return { hunks: [], additions: 0, deletions: 0 }

  // 1-based line number each op consumes, via prefix sums over op indices.
  const oldPrefix = new Int32Array(ops.length + 1)
  const newPrefix = new Int32Array(ops.length + 1)
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    oldPrefix[i + 1] = oldPrefix[i]! + (op.t === 2 ? 0 : 1)
    newPrefix[i + 1] = newPrefix[i]! + (op.t === 1 ? 0 : 1)
  }

  // 2) Group changes into hunks: merge clusters whose separating context gap
  // would overlap (gap ≤ 2 × HUNK_CONTEXT), exactly like unified diff.
  const groups: { from: number; to: number }[] = []
  let from = changeIdx[0]!
  let to = changeIdx[0]!
  for (let gi = 1; gi < changeIdx.length; gi++) {
    const idx = changeIdx[gi]!
    if (idx - to - 1 <= 2 * HUNK_CONTEXT) {
      to = idx
    } else {
      groups.push({ from, to })
      from = idx
      to = idx
    }
  }
  groups.push({ from, to })

  const hunks: FileHunk[] = []
  for (const group of groups) {
    const s = Math.max(0, group.from - HUNK_CONTEXT)
    const e = Math.min(ops.length, group.to + 1 + HUNK_CONTEXT)
    const lines: DiffLine[] = []
    let firstOld: number | undefined
    let firstNew: number | undefined
    let oldCount = 0
    let newCount = 0
    for (let i = s; i < e; i++) {
      const op = ops[i]!
      if (op.t === 0) {
        const oldNum = oldPrefix[i]! + 1
        const newNum = newPrefix[i]! + 1
        firstOld ??= oldNum
        firstNew ??= newNum
        oldCount += 1
        newCount += 1
        lines.push({ type: 'ctx', oldNum, newNum, text: a[op.a] ?? '' })
      } else if (op.t === 1) {
        const oldNum = oldPrefix[i]! + 1
        firstOld ??= oldNum
        oldCount += 1
        lines.push({ type: 'del', oldNum, text: a[op.a] ?? '' })
      } else {
        const newNum = newPrefix[i]! + 1
        firstNew ??= newNum
        newCount += 1
        lines.push({ type: 'add', newNum, text: b[op.b] ?? '' })
      }
    }
    // A hunk with only additions anchors at the old line before it (0 at the
    // file start), matching unified diff's `-N,0` convention; same for pure
    // deletions on the new side.
    const oldStart = firstOld ?? oldPrefix[s]!
    const newStart = firstNew ?? newPrefix[s]!
    hunks.push({ oldStart, oldLines: oldCount, newStart, newLines: newCount, lines })
  }

  return { hunks, additions, deletions }
}

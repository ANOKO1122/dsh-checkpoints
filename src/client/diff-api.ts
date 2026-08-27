/**
 * Shared HTTP helpers for the diff-facing client components
 * (FileStatsBar, RoundChangesCard, DiffViewerOverlay).
 */

export type Baseline = 'checkpoint' | 'session'

/** One file line-diff statistic served by the host. */
export interface FileDiffStat {
  readonly path: string
  readonly additions: number
  readonly deletions: number
  /** True when the file is binary; the counts are meaningless for it. */
  readonly binary?: boolean
  /** Presence change vs the snapshot: brand-new, removed, or content-edited. */
  readonly status?: 'added' | 'deleted' | 'modified'
}

/** Response of GET /diff — per-file stats against the selected baseline. */
export interface DiffResponse {
  readonly baseline: Baseline
  /** True when the requested checkpoint baseline had no snapshot and the
   *  server diffed against the session-start snapshot instead. */
  readonly degraded?: boolean
  readonly files: readonly FileDiffStat[]
  readonly totalAdditions: number
  readonly totalDeletions: number
}

/** One line inside a hunk (mirrors the host type). */
export interface DiffLine {
  readonly type: 'ctx' | 'add' | 'del'
  readonly oldNum?: number
  readonly newNum?: number
  readonly text: string
}

/** One unified-diff hunk (mirrors the host type). */
export interface FileHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly DiffLine[]
}

/** Response of GET /file-diff — the actual hunks of one file. */
export interface FileDiffDetail {
  readonly path: string
  readonly baseline: Baseline
  readonly degraded?: boolean
  readonly binary: boolean
  readonly tooLarge?: boolean
  readonly additions: number
  readonly deletions: number
  readonly hunks: readonly FileHunk[]
}

interface Envelope<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code?: string; readonly message?: string }
}

async function readEnvelope<T>(response: Response): Promise<Envelope<T>> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`bad response from server (HTTP ${response.status})`)
  }
  if (typeof body !== 'object' || body === null) throw new Error('bad response from server')
  return body as Envelope<T>
}

async function readValue<T>(response: Response, fallbackMessage: string): Promise<T> {
  const envelope = await readEnvelope<T>(response)
  if (!envelope.ok || envelope.value === undefined) {
    throw new Error(envelope.error?.message ?? fallbackMessage)
  }
  return envelope.value
}

/** Per-file +/− stats between the baseline snapshot and the workspace. */
export async function fetchDiff(sessionId: string, baseline: Baseline): Promise<DiffResponse> {
  const response = await fetch(
    `/plugins/dsh-checkpoints/diff?sessionId=${encodeURIComponent(sessionId)}&baseline=${baseline}`,
    { headers: { accept: 'application/json' } },
  )
  return readValue<DiffResponse>(response, 'failed to load file diff')
}

/** Unified-diff hunks of one file between the baseline snapshot and the workspace. */
export async function fetchFileDetail(
  sessionId: string,
  path: string,
  baseline: Baseline,
): Promise<FileDiffDetail> {
  const response = await fetch(
    `/plugins/dsh-checkpoints/file-diff?sessionId=${encodeURIComponent(sessionId)}`
    + `&path=${encodeURIComponent(path)}&baseline=${baseline}`,
    { headers: { accept: 'application/json' } },
  )
  return readValue<FileDiffDetail>(response, 'failed to load file comparison')
}

/** Restore one file from the baseline snapshot (per-file undo). */
export async function undoFile(sessionId: string, path: string, baseline: Baseline): Promise<void> {
  const response = await fetch('/plugins/dsh-checkpoints/undo-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sessionId, path, baseline }),
  })
  const envelope = await readEnvelope<{ path: string }>(response)
  if (!envelope.ok) {
    throw new Error(envelope.error?.message ?? 'undo file failed')
  }
}

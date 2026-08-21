/**
 * FileStatsBar — a VS Code-like file-change strip above the conversation.
 *
 * It polls the host diff route and shows per-file +/− line counts, with an
 * undo button that restores that single file from the selected baseline
 * (latest checkpoint or session start).
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { FileDiffStat, SessionFace } from './context-types.ts'
import css from './stats.module.css'

const DIFF_URL = '/plugins/dsh-checkpoints/diff'
const UNDO_FILE_URL = '/plugins/dsh-checkpoints/undo-file'

type Baseline = 'checkpoint' | 'session'

interface DiffResponse {
  readonly baseline: Baseline
  /** True when the requested checkpoint baseline had no snapshot and the
   *  server diffed against the session-start snapshot instead. */
  readonly degraded?: boolean
  readonly files: readonly FileDiffStat[]
  readonly totalAdditions: number
  readonly totalDeletions: number
}

interface Envelope<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly message?: string }
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

async function fetchDiff(sessionId: string, baseline: Baseline): Promise<DiffResponse> {
  const response = await fetch(`${DIFF_URL}?sessionId=${encodeURIComponent(sessionId)}&baseline=${baseline}`, {
    headers: { accept: 'application/json' },
  })
  const envelope = await readEnvelope<DiffResponse>(response)
  if (!envelope.ok || envelope.value === undefined) {
    throw new Error(envelope.error?.message ?? 'failed to load file diff')
  }
  return envelope.value
}

async function undoFile(sessionId: string, path: string, baseline: Baseline): Promise<void> {
  const response = await fetch(UNDO_FILE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sessionId, path, baseline }),
  })
  const envelope = await readEnvelope<{ path: string }>(response)
  if (!envelope.ok) {
    throw new Error(envelope.error?.message ?? 'undo file failed')
  }
}

interface FileStatsBarProps {
  readonly sessionId: string
  readonly session: SessionFace
  /** Render as an embedded sidebar section instead of a fixed floating card. */
  readonly embedded?: boolean
}

export function FileStatsBar({ sessionId, session, embedded = false }: FileStatsBarProps): ReactElement | null {
  const [baseline, setBaseline] = useState<Baseline>('checkpoint')
  const [data, setData] = useState<DiffResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const debounceRef = useRef<number>(0)
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchDiff(sessionId, baseline)
      if (mounted.current) {
        setData(next)
        setError(null)
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId, baseline])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      window.clearTimeout(debounceRef.current)
    }
  }, [])

  // Event-driven refresh: the session stream already signals every turn of
  // tool/file activity, so there is no polling loop — each burst of updates
  // triggers one debounced diff request, plus the manual refresh button.
  useEffect(() => {
    // Drop any pending refresh scheduled by a previous baseline/session.
    window.clearTimeout(debounceRef.current)
    void refresh()
    return session.subscribe(() => {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = window.setTimeout(() => { void refresh() }, 300)
    })
  }, [session, refresh])

  const undo = useCallback(async (path: string): Promise<void> => {
    if (!window.confirm(`撤销文件 ${path} 的改动？`)) return
    setBusyPath(path)
    setError(null)
    try {
      await undoFile(sessionId, path, baseline)
      if (mounted.current) await refresh()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setBusyPath(null)
    }
  }, [sessionId, baseline, refresh])

  const files = data?.files ?? []
  const totalAdditions = data?.totalAdditions ?? 0
  const totalDeletions = data?.totalDeletions ?? 0
  const hasChanges = files.length > 0
  const degraded = data?.degraded === true && baseline === 'checkpoint'

  return (
    <div className={embedded ? `${css.bar} ${css.embedded}` : css.bar}>
      <div className={css.head}>
        <span className={css.title}>文件改动</span>
        <span className={css.toggle}>
          <button
            type="button"
            className={css.toggleButton}
            data-active={baseline === 'checkpoint'}
            onClick={() => setBaseline('checkpoint')}
          >
            最近检查点
          </button>
          <button
            type="button"
            className={css.toggleButton}
            data-active={baseline === 'session'}
            onClick={() => setBaseline('session')}
          >
            本次会话
          </button>
        </span>
        <span className={css.summary}>
          {hasChanges
            ? `${files.length} 个文件 · +${totalAdditions} -${totalDeletions}`
            : '暂无文件改动'}
        </span>
        <button
          type="button"
          className={css.toggleButton}
          title="重新计算文件改动"
          onClick={() => { void refresh() }}
        >
          刷新
        </button>
        {hasChanges && (
          <button
            type="button"
            className={css.undo}
            onClick={() => setExpanded(current => !current)}
          >
            {expanded ? '收起' : '展开'}
          </button>
        )}
      </div>
      {degraded && (
        <div className={css.notice}>最近检查点没有文件快照，当前对比的是会话开始时的状态。</div>
      )}
      {error !== null && <div className={css.error}>{error}</div>}
      {expanded && hasChanges && (
        <div className={css.list}>
          {files.map((file) => (
            <div key={file.path} className={css.fileRow}>
              <span className={css.path} title={file.path}>{file.path}</span>
              <span className={css.delta}>
                {file.binary === true
                  ? <span className={css.binaryNote}>二进制</span>
                  : (
                    <>
                      <span className={css.add}>+{file.additions}</span>
                      {' '}
                      <span className={css.del}>-{file.deletions}</span>
                    </>
                  )}
              </span>
              <button
                type="button"
                className={css.undo}
                disabled={busyPath !== null && busyPath !== file.path}
                onClick={() => { void undo(file.path) }}
              >
                撤销
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

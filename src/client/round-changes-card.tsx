/**
 * RoundChangesCard — the "本轮改动" strip in the composer dock column.
 *
 * Mounted through the `conversation.input.dock` slot (order 5: right below
 * the shipped todo strip, above the input card), so it sits between the
 * task bar and the composer and shares the dock column's width/height
 * constraints. It shows the file changes of the current conversation round
 * (diff against the latest user instruction = 最近检查点 baseline) with an
 * internally scrolling file list. Clicking a file opens the
 * DiffViewerOverlay; per-file undo restores that single file from the
 * latest checkpoint snapshot.
 *
 * Like the shipped TodoPanel, the component renders `null` while the round
 * has no changes, so the dock column stays untouched. The list is collapsed
 * by default and the choice persists (localStorage) across session switches
 * and browser reloads; the header summary stays visible either way.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { SessionFace } from './context-types.ts'
import { fetchDiff, undoFile, type DiffResponse } from './diff-api.ts'
import { openFileDiff } from './diff-viewer.tsx'
import { splitPath } from './file-path.ts'
import css from './round-changes-card.module.css'

interface RoundChangesCardProps {
  readonly sessionId: string
  readonly session: SessionFace
}

/**
 * Persisted collapse preference for the round-changes strip: collapsed by
 * default, remembered across session switches and browser reloads via
 * localStorage (a fresh session remounts the card, so in-memory state would
 * forget the choice).
 */
const EXPANDED_KEY = 'dsh-checkpoints.round-changes.expanded'

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}

function writeExpanded(value: boolean): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, value ? '1' : '0')
  } catch {
    // Storage unavailable (privacy mode etc.): the choice just stays in-memory.
  }
}

export function RoundChangesCard({ sessionId, session }: RoundChangesCardProps): ReactElement | null {
  const [data, setData] = useState<DiffResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Default collapsed; the user's last choice survives session switches and
  // reloads through localStorage.
  const [expanded, setExpanded] = useState(readExpanded)
  const toggleExpanded = useCallback((): void => {
    setExpanded(current => {
      const next = !current
      writeExpanded(next)
      return next
    })
  }, [])
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const debounceRef = useRef<number>(0)
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchDiff(sessionId, 'checkpoint')
      if (mounted.current) {
        setData(next)
        setError(null)
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      window.clearTimeout(debounceRef.current)
    }
  }, [])

  // Same event-driven refresh as the sidebar stats bar: every session update
  // (tool/file activity, turn end) schedules one debounced diff request.
  useEffect(() => {
    window.clearTimeout(debounceRef.current)
    void refresh()
    return session.subscribe(() => {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = window.setTimeout(() => { void refresh() }, 300)
    })
  }, [session, refresh])

  const files = data?.files ?? []
  const hasChanges = files.length > 0
  const degraded = data?.degraded === true

  const undo = useCallback(async (path: string): Promise<void> => {
    if (!window.confirm(`撤销文件 ${path} 的本轮改动？`)) return
    setBusyPath(path)
    setError(null)
    try {
      await undoFile(sessionId, path, 'checkpoint')
      if (mounted.current) await refresh()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setBusyPath(null)
    }
  }, [sessionId, refresh])

  // Hidden entirely while this round has no changes and nothing to report —
  // the dock column then shows only the shipped strips (same posture as the
  // TodoPanel's empty render).
  if (!hasChanges && error === null) return null

  return (
    <div className={css.card}>
      <div className={css.head}>
        <span className={css.title}>本轮改动</span>
        <span className={css.summary}>
          {hasChanges
            ? `${files.length} 个文件 · +${data?.totalAdditions ?? 0} -${data?.totalDeletions ?? 0}`
            : '暂无文件改动'}
        </span>
        <button
          type="button"
          className={css.button}
          title="重新计算本轮文件改动"
          onClick={() => { void refresh() }}
        >
          刷新
        </button>
        {hasChanges && (
          <button
            type="button"
            className={css.button}
            onClick={toggleExpanded}
          >
            {expanded ? '收起' : '展开'}
          </button>
        )}
      </div>
      {degraded && (
        <div className={css.notice}>最近检查点没有文件快照，以下对比的是会话开始时的状态。</div>
      )}
      {error !== null && <div className={css.error}>{error}</div>}
      {expanded && hasChanges && (
        <div className={css.list}>
          {files.map((file) => {
            const { name, dir } = splitPath(file.path)
            return (
              <div key={file.path} className={css.fileRow}>
                <button
                  type="button"
                  className={css.path}
                  title={`查看 ${file.path} 的差异`}
                  onClick={() => { openFileDiff(sessionId, file.path, 'checkpoint') }}
                >
                  <span className={css.fileName}>{name}</span>
                  {dir !== '' && <span className={css.fileDir}>{dir}</span>}
                </button>
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
            )
          })}
        </div>
      )}
    </div>
  )
}

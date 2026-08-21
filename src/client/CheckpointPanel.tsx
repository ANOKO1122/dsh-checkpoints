/**
 * CheckpointPanel — the checkpoint list rendered inside the right-hand
 * sidebar.
 *
 * It reads checkpoints from the host route and lets the user click a row to
 * smooth-scroll to that instruction. Rewind / edit actions are intentionally
 * not here anymore: editing happens inline on the conversation bubble, and
 * file rollback is offered during that inline edit flow.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { Checkpoint, SessionFace } from './context-types.ts'
import css from './panel.module.css'

const LIST_URL = '/plugins/dsh-checkpoints/list'

interface CheckpointPanelProps {
  readonly session: SessionFace
  readonly scrollport: HTMLElement
  /** Render as an embedded sidebar section instead of a floating FAB + popover. */
  readonly embedded?: boolean
}

interface ApiEnvelope<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code?: string; readonly message?: string }
}

async function readEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`bad response from server (HTTP ${response.status})`)
  }
  if (typeof body !== 'object' || body === null) {
    throw new Error('bad response from server: expected JSON object')
  }
  return body as ApiEnvelope<T>
}

async function fetchCheckpoints(sessionId: string): Promise<Checkpoint[]> {
  const response = await fetch(`${LIST_URL}?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: { accept: 'application/json' },
  })
  const envelope = await readEnvelope<{ checkpoints: Checkpoint[] }>(response)
  if (!envelope.ok || envelope.value === undefined) {
    throw new Error(envelope.error?.message ?? 'failed to load checkpoints')
  }
  return envelope.value.checkpoints
}

function formatTime(time: number): string {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}

function findAnchorRow(scrollport: HTMLElement, key: string): HTMLElement | null {
  for (const el of scrollport.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
    if (el.dataset.chatAnchorKey === key) return el
  }
  return null
}

function scrollToRow(scrollport: HTMLElement, row: HTMLElement): void {
  const rowRect = row.getBoundingClientRect()
  const spRect = scrollport.getBoundingClientRect()
  const target = scrollport.scrollTop + (rowRect.top - spRect.top) - spRect.height * 0.5 + rowRect.height * 0.5
  const top = Math.max(0, target)
  if (typeof scrollport.scrollTo === 'function') {
    scrollport.scrollTo({ top, behavior: 'smooth' })
  } else {
    scrollport.scrollTop = top
  }
}

export function CheckpointPanel({ session, scrollport, embedded = false }: CheckpointPanelProps): ReactElement | null {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mounted = useRef(true)
  const refreshDebounce = useRef<number>(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (!mounted.current) return
    setLoading(true)
    setError(null)
    try {
      const next = await fetchCheckpoints(session.sessionId)
      if (mounted.current) setCheckpoints(next)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [session.sessionId])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      window.clearTimeout(refreshDebounce.current)
    }
  }, [])

  // Refresh on mount and whenever the session emits updates, so a panel that
  // stays open still shows newly sent instructions.
  useEffect(() => {
    // Drop any pending refresh scheduled by a previous session.
    window.clearTimeout(refreshDebounce.current)
    void refresh()
    return session.subscribe(() => {
      window.clearTimeout(refreshDebounce.current)
      refreshDebounce.current = window.setTimeout(() => { void refresh() }, 400)
    })
  }, [session, refresh])

  const scrollToCheckpoint = useCallback(async (seq: number): Promise<void> => {
    const findRow = (): HTMLElement | null => {
      const chat = session.snapshotCache.chat
      if (!chat) return null
      for (const node of chat.nodes.values()) {
        if (node.anchorSeq !== seq) continue
        const row = findAnchorRow(scrollport, node.key)
        if (row) {
          console.info('[dsh-checkpoints] locate checkpoint', { seq, key: node.key })
          return row
        }
        return null
      }
      return null
    }

    // After `loadOlder` resolves, the snapshot has the new page but React may
    // need a few frames to commit the rows into the DOM. Poll briefly instead
    // of giving up after one animation frame.
    const waitForRow = async (): Promise<HTMLElement | null> => {
      const deadline = Date.now() + 2500
      while (Date.now() < deadline) {
        const found = findRow()
        if (found !== null) return found
        await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
      }
      return findRow()
    }

    let row = findRow()
    if (row === null && typeof session.loadOlder === 'function') {
      setNotice('正在加载更早的消息以定位…')
      const snapshot = session.snapshotCache as { hasMore?: boolean }
      for (let attempt = 0; attempt < 20 && row === null; attempt++) {
        if (snapshot.hasMore === false) break
        const before = snapshot.hasMore
        try {
          await session.loadOlder()
        } catch (cause) {
          console.warn('[dsh-checkpoints] loadOlder failed while locating:', cause)
          break
        }
        row = await waitForRow()
        if (row === null && before === snapshot.hasMore) break
      }
    }

    if (row !== null) {
      scrollToRow(scrollport, row)
      setNotice(null)
      return
    }
    setNotice('无法定位：当前会话窗口中没有渲染该检查点。')
    console.warn('[dsh-checkpoints] locate row not found', { seq })
  }, [session, scrollport])

  const body = (
    <div className={css.body}>
      {loading && checkpoints.length === 0 && <div className={css.empty}>加载中…</div>}
      {!loading && checkpoints.length === 0 && !error && (
        <div className={css.empty}>还没有可用的用户指令检查点。</div>
      )}
      {error !== null && <div className={css.error}>{error}</div>}
      {notice !== null && <div className={css.notice}>{notice}</div>}
      {checkpoints.map((checkpoint, index) => (
        <div
          key={checkpoint.seq}
          className={css.row}
          role="button"
          tabIndex={0}
          aria-label={`定位到检查点 ${index + 1}`}
          onClick={() => { void scrollToCheckpoint(checkpoint.seq) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              void scrollToCheckpoint(checkpoint.seq)
            }
          }}
        >
          <div className={css.rowHead}>
            <span className={css.index}>#{index + 1}</span>
            {checkpoint.hasSnapshot === true && (
              <span className={css.snapBadge} title="该检查点有文件快照，编辑/回退时可同时恢复文件">⭯</span>
            )}
            <span className={css.time}>{formatTime(checkpoint.time)}</span>
          </div>
          <div className={css.preview}>{checkpoint.text || '(空消息)'}</div>
        </div>
      ))}
    </div>
  )

  if (embedded) {
    return (
      <div className={`${css.panel} ${css.embedded}`}>
        <div className={css.head}>
          <span className={css.title}>检查点</span>
        </div>
        {body}
      </div>
    )
  }

  return (
    <div className={css.panel} role="dialog" aria-label="对话检查点">
      <div className={css.head}>
        <span className={css.title}>检查点</span>
      </div>
      {body}
    </div>
  )
}

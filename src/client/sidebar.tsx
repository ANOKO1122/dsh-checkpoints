/**
 * Sidebar integration for checkpoints + file changes.
 *
 * The DSH frame has no add-a-right-column slot (the right `details` column is
 * owned by tool details), so we use the additive root-scope `shell.overlay`
 * slot for both pieces:
 *   - a right-edge tab (while closed)
 *   - the docked right-hand panel itself (while open)
 *
 * One tiny external store keeps the tab and the panel in sync, and the panel
 * renders the existing CheckpointPanel / FileStatsBar in `embedded` mode
 * (no floating chrome).
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { SessionFace, SessionListState } from './context-types.ts'
import { CheckpointPanel } from './CheckpointPanel.tsx'
import { FileStatsBar } from './FileStatsBar.tsx'
import css from './sidebar.module.css'

export interface PanelStore {
  getSnapshot(): boolean
  subscribe(listener: () => void): () => void
  toggle(): void
  close(): void
}

export function createPanelStore(): PanelStore {
  let open = false
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => open,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    toggle: () => {
      open = !open
      emit()
    },
    close: () => {
      if (!open) return
      open = false
      emit()
    },
  }
}

const HISTORY_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1.75C4.548 1.75 1.75 4.548 1.75 8s2.798 6.25 6.25 6.25S14.25 11.452 14.25 8h-1.5A4.75 4.75 0 1 1 8 3.25c1.35 0 2.566.567 3.42 1.475L10 6h4V2l-1.5 1.5C11.3 2.27 9.75 1.75 8 1.75ZM8 4.75v3.5l2.75 1.625.5-.875L9 7.5V4.75H8Z" fill="currentColor"/></svg>`

interface SidebarPanelProps {
  readonly session: SessionFace
  readonly scrollport: HTMLElement
  readonly onClose: () => void
}

export function CheckpointSidebarPanel({ session, scrollport, onClose }: SidebarPanelProps) {
  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>检查点 · 文件改动</span>
        <button type="button" className={css.close} aria-label="关闭" title="关闭" onClick={onClose}>×</button>
      </div>
      <div className={css.body}>
        <CheckpointPanel
          embedded
          session={session}
          scrollport={scrollport}
        />
        <FileStatsBar
          embedded
          sessionId={session.sessionId}
          session={session}
        />
      </div>
    </div>
  )
}

/** Framework props delivered to root-scope slot components. */
export interface RootSlotRuntimeProps {
  readonly useSessions: <S>(selector: (state: SessionListState) => S, eq?: (a: S, b: S) => boolean) => S
}

interface OverlaySlotProps extends RootSlotRuntimeProps {
  readonly panelStore: PanelStore
  readonly sessions: {
    binding(id: string): { readonly session: SessionFace } | undefined
  }
}

/** `shell.overlay` entry: a right-edge tab while closed, and the docked
 *  right-hand panel while open. */
export function CheckpointSidebarOverlay({ panelStore, sessions, useSessions }: OverlaySlotProps) {
  const open = useSyncExternalStore(
    useCallback((listener: () => void) => panelStore.subscribe(listener), [panelStore]),
    useCallback(() => panelStore.getSnapshot(), [panelStore]),
  )
  const sessionId = useSessions((state) => state.current)

  if (sessionId === undefined) return null
  const binding = sessions.binding(sessionId)
  if (binding === undefined) return null

  if (!open) {
    return (
      <button
        type="button"
        className={css.edgeButton}
        aria-label="打开检查点 · 文件改动"
        aria-expanded={false}
        title="检查点 · 文件改动"
        onClick={() => { panelStore.toggle() }}
      >
        <span className={css.edgeIcon} dangerouslySetInnerHTML={{ __html: HISTORY_ICON }} />
        <span className={css.edgeLabel}>检查点</span>
      </button>
    )
  }

  const scrollport = document.querySelector<HTMLElement>('[data-conversation-scroll]')
  if (scrollport === null) return null

  return (
    <CheckpointSidebarPanel
      session={binding.session}
      scrollport={scrollport}
      onClose={() => { panelStore.close() }}
    />
  )
}

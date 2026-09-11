/**
 * File-only sidebar. Turn navigation is provided by the native Harness rail.
 *
 * The DSH frame has no add-a-right-column slot (the right `details` column is
 * owned by tool details), so we use the additive root-scope `shell.overlay`
 * slot for both pieces:
 *   - a right-edge tab (while closed)
 *   - the docked right-hand panel itself (while open)
 *
 * One tiny external store keeps the tab and the panel in sync, and the panel
 * renders FileStatsBar in `embedded` mode
 * (no floating chrome).
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { SessionFace, SessionListState } from './context-types.ts'
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

const FILES_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.75h5l3 3v9.5H4zM9 1.75v3h3M6 8h4M6 10.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

interface SidebarPanelProps {
  readonly session: SessionFace
  readonly onClose: () => void
}

export function CheckpointSidebarPanel({ session, onClose }: SidebarPanelProps) {
  return (
    <div className={css.root} role="complementary" aria-label="文件改动">
      <div className={css.header}>
        <span className={css.title}>文件改动</span>
        <button type="button" className={css.close} aria-label="关闭" title="关闭" onClick={onClose}>×</button>
      </div>
      <div className={css.body}>
        <FileStatsBar
          key={session.sessionId}
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
        aria-label="打开文件改动"
        aria-expanded={false}
        title="文件改动"
        onClick={() => { panelStore.toggle() }}
      >
        <span className={css.edgeIcon} dangerouslySetInnerHTML={{ __html: FILES_ICON }} />
        <span className={css.edgeLabel}>文件改动</span>
      </button>
    )
  }

  return (
    <CheckpointSidebarPanel
      session={binding.session}
      onClose={() => { panelStore.close() }}
    />
  )
}

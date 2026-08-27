/**
 * DiffViewerOverlay — a VS Code-like file comparison dialog.
 *
 * Left: the changed files as a collapsible directory tree (VS Code changes-tree
 * style): every folder level folds independently, rows show only the basename
 * so lines stay short, and per-file A/M/D + +/− badges mirror the reference
 * screenshot. Right: the actual diff of the selected file with line numbers and
 * colored added/removed lines, switchable between unified (统一视图) and
 * side-by-side (并排视图) layout.
 *
 * The dialog is a module-singleton store + an overlay component registered in
 * the `shell.overlay` slot; any component (round card, sidebar stats bar)
 * opens it through `openFileDiff()`.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import {
  fetchDiff,
  fetchFileDetail,
  type Baseline,
  type DiffResponse,
  type FileDiffDetail,
  type FileDiffStat,
  type FileHunk,
} from './diff-api.ts'
import css from './diff-viewer.module.css'

export interface DiffViewerState {
  readonly open: boolean
  readonly sessionId?: string
  readonly path?: string
  readonly baseline: Baseline
}

export interface DiffViewerStore {
  getSnapshot(): DiffViewerState
  subscribe(listener: () => void): () => void
  open(sessionId: string, path: string, baseline: Baseline): void
  select(path: string): void
  close(): void
}

export function createDiffViewerStore(): DiffViewerStore {
  let state: DiffViewerState = { open: false, baseline: 'checkpoint' }
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open: (sessionId, path, baseline) => {
      state = { open: true, sessionId, path, baseline }
      emit()
    },
    select: (path) => {
      if (!state.open || state.path === path) return
      state = { ...state, path }
      emit()
    },
    close: () => {
      if (!state.open) return
      state = { ...state, open: false }
      emit()
    },
  }
}

/** Module-level singleton: one diff viewer per web client. */
export const diffViewerStore: DiffViewerStore = createDiffViewerStore()

/** Open the comparison dialog for one file. */
export function openFileDiff(sessionId: string, path: string, baseline: Baseline): void {
  diffViewerStore.open(sessionId, path, baseline)
}

type ViewMode = 'unified' | 'split'

function baselineLabel(baseline: Baseline): string {
  return baseline === 'checkpoint' ? '对比最近检查点' : '对比会话开始'
}

/** Pair del/add lines row-wise for the side-by-side view. */
function splitRows(lines: readonly { readonly type: string }[]): { left?: unknown; right?: unknown }[] {
  const rows: { left?: unknown; right?: unknown }[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.type === 'ctx') {
      rows.push({ left: line, right: line })
      i += 1
      continue
    }
    // Collect the contiguous del block then the contiguous add block. Both
    // loops MUST advance `i` — forgetting it spins forever on the first
    // changed line and freezes the tab.
    const dels: unknown[] = []
    const adds: unknown[] = []
    while (i < lines.length && lines[i]!.type === 'del') {
      dels.push(lines[i]!)
      i += 1
    }
    while (i < lines.length && lines[i]!.type === 'add') {
      adds.push(lines[i]!)
      i += 1
    }
    const len = Math.max(dels.length, adds.length)
    for (let r = 0; r < len; r++) rows.push({ left: dels[r], right: adds[r] })
  }
  return rows
}

function Delta({ additions, deletions }: { additions: number; deletions: number }): ReactElement {
  return (
    <span className={css.delta}>
      <span className={css.add}>+{additions}</span>
      {' '}
      <span className={css.del}>-{deletions}</span>
    </span>
  )
}

/** One hunk in unified layout. */
function UnifiedHunk({ hunk }: { hunk: FileHunk }): ReactElement {
  return (
    <div className={css.hunk}>
      <div className={css.hunkHead}>
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      {hunk.lines.map((line, index) => (
        <div key={index} className={`${css.line} ${line.type === 'add' ? css.lineAdd : line.type === 'del' ? css.lineDel : css.lineCtx}`}>
          <span className={css.numOld}>{line.oldNum ?? ''}</span>
          <span className={css.numNew}>{line.newNum ?? ''}</span>
          <span className={css.sign}>{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
          <span className={css.text}>{line.text}</span>
        </div>
      ))}
    </div>
  )
}

/** One hunk in side-by-side layout. */
function SplitHunk({ hunk }: { hunk: FileHunk }): ReactElement {
  const rows = splitRows(hunk.lines)
  const renderSide = (line: unknown, kind: 'old' | 'new'): ReactElement => {
    if (line === undefined) {
      return (
        <div className={`${css.line} ${css.linePad}`}>
          <span className={css.numOld} />
          <span className={css.sign} />
          <span className={css.text} />
        </div>
      )
    }
    const l = line as { type: string; oldNum?: number; newNum?: number; text: string }
    const num = kind === 'old' ? l.oldNum : l.newNum
    const changed = kind === 'old' ? l.type === 'del' : l.type === 'add'
    return (
      <div className={`${css.line} ${changed ? (kind === 'old' ? css.lineDel : css.lineAdd) : css.lineCtx}`}>
        <span className={css.numOld}>{num ?? ''}</span>
        <span className={css.sign}>{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
        <span className={css.text}>{l.text}</span>
      </div>
    )
  }
  return (
    <div className={css.hunk}>
      <div className={css.hunkHead}>
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      {rows.map((row, index) => (
        <div key={index} className={css.splitRow}>
          <div className={css.splitSide}>{renderSide(row.left, 'old')}</div>
          <div className={css.splitSide}>{renderSide(row.right, 'new')}</div>
        </div>
      ))}
    </div>
  )
}

/** Letter badge per presence status, mirroring git/SCM conventions. */
const STATUS_BADGE: Record<NonNullable<FileDiffStat['status']>, { letter: string; title: string }> = {
  added: { letter: 'A', title: '新增文件' },
  deleted: { letter: 'D', title: '已删除' },
  modified: { letter: 'M', title: '已修改' },
}

/** File-glyph tints per extension group (VS Code-like set-ID colors). */
const EXT_TINTS: readonly (readonly [exts: readonly string[], tint: string])[] = [
  [['js', 'mjs', 'cjs', 'jsx', 'json', 'jsonc'], '#dcb95e'],
  [['ts', 'mts', 'cts', 'tsx'], '#5ea7e6'],
  [['css', 'scss', 'less'], '#7aa2f7'],
  [['vue'], '#7fd18a'],
  [['html', 'htm', 'svg', 'xml'], '#e0827f'],
  [['md', 'mdx', 'txt'], '#9aa4b2'],
  [['yml', 'yaml', 'toml'], '#c68add'],
  [['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'avif'], '#6bd4c6'],
]

/** Tint for a file name's extension group; unknown extensions stay neutral. */
function extTint(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
  for (const [exts, tint] of EXT_TINTS) {
    if (exts.includes(ext)) return tint
  }
  return 'var(--dsw-alias-label-tertiary)'
}

const CHEVRON_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`

const FILE_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4.5 1.5h4.6l3.4 3.4v9.1a.5.5 0 0 1-.5.5H4.5a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.75V5.2h3.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`

/** A node of the changed-file tree: one directory level or one changed file. */
type FileTreeNode =
  | { readonly kind: 'dir'; readonly name: string; readonly dirPath: string; readonly children: FileTreeNode[] }
  | { readonly kind: 'file'; readonly name: string; readonly path: string; readonly file: FileDiffStat }

/**
 * Nest the flat changed-file list into a directory tree — directories first,
 * then files, both alphabetical, the VS Code changes-tree shape. Every path
 * segment becomes its own collapsible level (no single-child compression), so
 * folders and subfolders fold separately.
 */
function buildFileTree(files: readonly FileDiffStat[]): FileTreeNode[] {
  const dirs = new Map<string, { kind: 'dir'; name: string; dirPath: string; children: FileTreeNode[] }>()
  const root: FileTreeNode[] = []

  const ensureDir = (segments: readonly string[]): { children: FileTreeNode[] } => {
    if (segments.length === 0) return { children: root }
    const dirPath = segments.join('/')
    const existing = dirs.get(dirPath)
    if (existing !== undefined) return existing
    const parent = ensureDir(segments.slice(0, -1))
    const node = { kind: 'dir' as const, name: segments[segments.length - 1]!, dirPath, children: [] }
    dirs.set(dirPath, node)
    parent.children.push(node)
    return node
  }

  for (const file of files) {
    const segments = file.path.split(/[\\/]/).filter((segment) => segment.length > 0)
    const name = segments[segments.length - 1] ?? file.path
    ensureDir(segments.slice(0, -1)).children.push({ kind: 'file', name, path: file.path, file })
  }

  const sortLevel = (nodes: FileTreeNode[]): void => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    for (const node of nodes) {
      if (node.kind === 'dir') sortLevel(node.children)
    }
  }
  sortLevel(root)
  return root
}

/**
 * The left column's changed-file tree. Folders at every level collapse
 * independently and default to expanded (VS Code changes-tree style); file
 * rows show only the basename so lines stay short — the full path lives in
 * the tooltip and the footer, and only genuinely long names ellipsize.
 */
function FileTree({
  files,
  selectedPath,
  onSelect,
}: {
  files: readonly FileDiffStat[]
  selectedPath: string | undefined
  onSelect: (path: string) => void
}): ReactElement {
  // A set of collapsed directory paths; anything absent is expanded, so
  // folders that appear after a refetch start expanded too.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const tree = useMemo(() => buildFileTree(files), [files])

  // Deep links (`openFileDiff` with a nested path) must reveal the selection:
  // re-expand its ancestor folders whenever the selection changes.
  useEffect(() => {
    if (selectedPath === undefined) return
    const segments = selectedPath.split(/[\\/]/)
    setCollapsed((prev) => {
      let changed = false
      const next = new Set(prev)
      for (let i = 1; i < segments.length - 1; i++) {
        if (next.delete(segments.slice(0, i).join('/'))) changed = true
      }
      return changed ? next : prev
    })
  }, [selectedPath])

  const toggleDir = useCallback((dirPath: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }, [])

  const renderRows = (nodes: readonly FileTreeNode[], depth: number): ReactElement[] =>
    nodes.flatMap((node): ReactElement[] => {
      const indent = { '--depth': depth } as CSSProperties
      if (node.kind === 'dir') {
        const isCollapsed = collapsed.has(node.dirPath)
        return [
          <button
            key={`dir:${node.dirPath}`}
            type="button"
            className={css.treeRow}
            style={indent}
            aria-expanded={!isCollapsed}
            title={node.dirPath}
            onClick={() => { toggleDir(node.dirPath) }}
          >
            <span className={css.rowMark}>
              <span
                className={isCollapsed ? css.chevronClosed : css.chevronOpen}
                dangerouslySetInnerHTML={{ __html: CHEVRON_SVG }}
              />
            </span>
            <span className={css.rowName}>{node.name}</span>
          </button>,
          ...(isCollapsed ? [] : renderRows(node.children, depth + 1)),
        ]
      }
      const { file } = node
      const status = file.status !== undefined ? STATUS_BADGE[file.status] : undefined
      return [
        <button
          key={`file:${node.path}`}
          type="button"
          className={css.treeRow}
          style={indent}
          data-selected={selectedPath === node.path}
          title={node.path}
          onClick={() => { onSelect(node.path) }}
        >
          <span className={css.rowMark}>
            <span
              className={css.fileIcon}
              style={{ color: extTint(node.name) }}
              dangerouslySetInnerHTML={{ __html: FILE_ICON_SVG }}
            />
          </span>
          <span className={css.rowName}>{node.name}</span>
          {file.binary === true
            ? <span className={css.binaryNote}>二进制</span>
            : (
              <span className={css.rowDelta}>
                {status !== undefined && (
                  <span className={css.statusBadge} data-status={file.status} title={status.title}>{status.letter}</span>
                )}
                {file.additions > 0 && <span className={css.add}>+{file.additions}</span>}
                {file.deletions > 0 && <span className={css.del}>-{file.deletions}</span>}
              </span>
            )}
        </button>,
      ]
    })

  return <div className={css.tree}>{renderRows(tree, 0)}</div>
}

/** The overlay component; register once in the `shell.overlay` slot. */
export function DiffViewerOverlay(): ReactElement | null {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => diffViewerStore.subscribe(listener), []),
    useCallback(() => diffViewerStore.getSnapshot(), []),
  )
  const [view, setView] = useState<ViewMode>('unified')
  const [files, setFiles] = useState<DiffResponse | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [detail, setDetail] = useState<FileDiffDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const open = state.open && state.sessionId !== undefined

  // Escape closes the dialog.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') diffViewerStore.close()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open])

  // Changed-file list for the dialog's left column.
  useEffect(() => {
    if (!open || state.sessionId === undefined) return
    let cancelled = false
    setFilesError(null)
    fetchDiff(state.sessionId, state.baseline)
      .then((next) => { if (!cancelled) setFiles(next) })
      .catch((cause: unknown) => { if (!cancelled) setFilesError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [open, state.sessionId, state.baseline, state.path])

  // Diff content of the selected file.
  useEffect(() => {
    if (!open || state.sessionId === undefined || state.path === undefined) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    fetchFileDetail(state.sessionId, state.path, state.baseline)
      .then((next) => { if (!cancelled) setDetail(next) })
      .catch((cause: unknown) => { if (!cancelled) setDetailError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [open, state.sessionId, state.path, state.baseline])

  if (!open || state.sessionId === undefined) return null
  const sessionId = state.sessionId
  const path = state.path
  const fileList = files?.files ?? []
  const hunks = detail?.hunks ?? []
  const showDiff = detail !== null && detail.binary !== true && detail.tooLarge !== true
  // Render budget: a huge diff (thousands of lines) would block the main
  // thread while mounting; cap the rows and say so instead of hanging.
  const MAX_RENDER_LINES = 6000
  let renderBudget = MAX_RENDER_LINES
  let renderTruncated = false
  const renderHunks: FileHunk[] = []
  if (showDiff) {
    for (const hunk of hunks) {
      if (renderBudget <= 0) {
        renderTruncated = true
        break
      }
      if (hunk.lines.length <= renderBudget) {
        renderHunks.push(hunk)
        renderBudget -= hunk.lines.length
      } else {
        renderHunks.push({ ...hunk, lines: hunk.lines.slice(0, renderBudget) })
        renderTruncated = true
        renderBudget = 0
      }
    }
  }

  return (
    <div className={css.backdrop} onClick={() => { diffViewerStore.close() }}>
      <div
        className={css.dialog}
        role="dialog"
        aria-label="文件改动比对"
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className={css.header}>
          <span className={css.title}>文件比对</span>
          <span className={css.badge}>{baselineLabel(state.baseline)}</span>
          {detail?.degraded === true && (
            <span className={css.degraded} title="该基线没有文件快照，已回退为与会话开始时的状态比较">基线已回退</span>
          )}
          <span className={css.spacer} />
          {showDiff && <Delta additions={detail!.additions} deletions={detail!.deletions} />}
          <span className={css.viewToggle}>
            <button
              type="button"
              className={css.viewButton}
              data-active={view === 'unified'}
              onClick={() => { setView('unified') }}
            >
              统一视图
            </button>
            <button
              type="button"
              className={css.viewButton}
              data-active={view === 'split'}
              onClick={() => { setView('split') }}
            >
              并排视图
            </button>
          </span>
          <button type="button" className={css.close} aria-label="关闭" title="关闭 (Esc)" onClick={() => { diffViewerStore.close() }}>×</button>
        </div>
        <div className={css.body}>
          <div className={css.fileList}>
            {filesError === null && fileList.length > 0 && files !== null && (
              <div className={css.treeSummary}>
                <span>{fileList.length} 个文件变更</span>
                <span className={css.delta}>
                  <span className={css.add}>+{files.totalAdditions}</span>
                  <span className={css.del}>-{files.totalDeletions}</span>
                </span>
              </div>
            )}
            <div className={css.treeScroll}>
              {filesError !== null && <div className={css.paneError}>{filesError}</div>}
              {filesError === null && fileList.length === 0 && (
                <div className={css.paneEmpty}>{files === null ? '加载中…' : '没有文件改动'}</div>
              )}
              {filesError === null && fileList.length > 0 && (
                <FileTree
                  files={fileList}
                  selectedPath={path}
                  onSelect={(next) => { diffViewerStore.select(next) }}
                />
              )}
            </div>
          </div>
          <div className={css.diffPane}>
            {path === undefined && <div className={css.paneEmpty}>选择左侧文件查看差异</div>}
            {path !== undefined && detailLoading && <div className={css.paneEmpty}>加载差异中…</div>}
            {path !== undefined && !detailLoading && detailError !== null && (
              <div className={css.paneError}>{detailError}</div>
            )}
            {path !== undefined && !detailLoading && detailError === null && detail?.binary === true && (
              <div className={css.paneEmpty}>二进制文件内容不同，无法按行比较。</div>
            )}
            {path !== undefined && !detailLoading && detailError === null && detail?.tooLarge === true && (
              <div className={css.paneEmpty}>文件过大，无法显示逐行差异（可仍使用侧栏的「撤销」恢复）。</div>
            )}
            {path !== undefined && !detailLoading && detailError === null && showDiff && hunks.length === 0 && (
              <div className={css.paneEmpty}>内容相同，没有差异。</div>
            )}
            {showDiff && hunks.length > 0 && (
              <div className={view === 'split' ? css.diffSplit : css.diffUnified}>
                {view === 'split' && renderTruncated && (
                  <div className={css.truncatedNote}>
                    差异过大，仅渲染前 {MAX_RENDER_LINES} 行；可改用「撤销」或编辑器查看完整内容。
                  </div>
                )}
                {renderHunks.map((hunk, index) => (
                  view === 'split'
                    ? <SplitHunk key={index} hunk={hunk} />
                    : <UnifiedHunk key={index} hunk={hunk} />
                ))}
              </div>
            )}
          </div>
        </div>
        <div className={css.footer}>
          <span className={css.footerPath} title={path ?? ''}>{path ?? '未选择文件'}</span>
          <span className={css.footerSession} title={sessionId}>{baselineLabel(state.baseline)} · 会话 {sessionId}</span>
        </div>
      </div>
    </div>
  )
}

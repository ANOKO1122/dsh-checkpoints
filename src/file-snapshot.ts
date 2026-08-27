/**
 * File snapshot / restore / diff support for dsh-checkpoints.
 *
 * Current default provider: hybrid (VS Code-like).
 * - In Git repositories: tracked files use a lightweight git snapshot
 *   (`git stash create`), and untracked/new files are copied into a side
 *   directory. This means first-time file changes are detected/restorable.
 * - Outside Git: a full copy snapshot is used.
 *
 * This module deliberately only restores/overwrites files that exist in the
 * snapshot for whole-workspace rollback. Files created after the snapshot are
 * left in place (safe default); per-file undo may delete a file that did not
 * exist in the snapshot.
 */

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, copyFile, writeFile, stat, rename, rm } from 'node:fs/promises'
import { join, dirname, resolve as resolvePath, sep } from 'node:path'
import { homedir } from 'node:os'

const execFileAsync = promisify(execFile)

/** A per-file line-diff statistic. */
export interface FileDiffStat {
  readonly path: string
  readonly additions: number
  readonly deletions: number
  /** True when the file is binary; counts are meaningless for it. */
  readonly binary?: boolean
  /** Presence change vs the snapshot: brand-new, removed, or content-edited. */
  readonly status?: 'added' | 'deleted' | 'modified'
}

/** A captured workspace snapshot reference. */
export interface SnapshotRecord {
  readonly kind: 'git' | 'copy' | 'hybrid'
  readonly id: string
  readonly time: number
  /** Git commit/tree for tracked files (git/hybrid). */
  readonly commit?: string
  /** Full copy snapshot directory (copy). */
  readonly dir?: string
  /** Copy of untracked files at snapshot time (hybrid). */
  readonly untrackedDir?: string
}

/** Per-session snapshot index persisted as JSON. */
export interface SnapshotIndex {
  readonly start?: SnapshotRecord
  readonly bySeq: Record<number, SnapshotRecord>
}

const execOptions = { windowsHide: true, maxBuffer: 16 * 1024 * 1024 } as const

/** Files larger than this are skipped by copy snapshots (with a warning). */
const MAX_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024

/** How many files/directories copy snapshots may process concurrently. */
const COPY_CONCURRENCY = 8

/** Run `fn` over `items` with at most `limit` concurrent executions. */
async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const item = items[index]
      index += 1
      if (item === undefined) break
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/** Directories never copied by the copy provider. */
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.turbo',
  '.dsh', '.DS_Store', 'coverage', '.venv', 'venv', '__pycache__',
])

/** Whether a directory is a Git repository (or inside one). */
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], execOptions)
    return true
  } catch {
    return false
  }
}

/** Create a git snapshot object without touching index/worktree. */
async function createGitSnapshot(cwd: string): Promise<string> {
  // `git stash create` returns the commit id of a new stash entry.
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'stash', 'create'], execOptions)
  const commit = stdout.trim()
  if (commit === '') {
    // Nothing to stash (clean tree). Use HEAD as a stable snapshot.
    const head = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD'], execOptions)
    const headCommit = head.stdout.trim()
    if (headCommit === '') throw new Error('git snapshot failed: no HEAD and no changes')
    return headCommit
  }
  return commit
}

/**
 * Pin a snapshot commit under a plugin-owned ref so `git gc` cannot prune it:
 * commits from `git stash create` are dangling objects and would otherwise
 * expire after the default grace period, breaking old snapshots.
 */
async function pinGitSnapshot(cwd: string, commit: string, ref: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', cwd, 'update-ref', ref, commit], execOptions)
  } catch {
    // Best-effort: an unpinned snapshot only degrades to today's behaviour.
  }
}

/** List untracked file paths (relative to cwd), excluding ignored files. */
async function listUntrackedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard', '-z'], execOptions,
    )
    const paths = stdout.split('\0').filter(path => path !== '')
    return paths.sort()
  } catch (error: unknown) {
    // A silent [] here would quietly exclude untracked files from snapshots.
    console.warn(`dsh-checkpoints: git ls-files failed for ${cwd}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/** Copy only untracked files into a snapshot directory. */
async function copyUntrackedFiles(cwd: string, dest: string): Promise<void> {
  const files = await listUntrackedFiles(cwd)
  await forEachWithConcurrency(files, COPY_CONCURRENCY, async (rel) => {
    const source = join(cwd, rel)
    const target = join(dest, rel)
    try {
      const info = await stat(source)
      if (info.size > MAX_SNAPSHOT_FILE_BYTES) {
        console.warn(`dsh-checkpoints: snapshot skipped large file (${info.size} bytes): ${rel}`)
        return
      }
    } catch {
      // stat failed; let copyFile surface the real error.
    }
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  })
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (cleaned !== '') return cleaned.slice(0, 64)
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function defaultSnapshotRoot(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-checkpoints')
}

function sessionDir(root: string, sessionId: string): string {
  return join(root, 'sessions', safeSegment(sessionId))
}

function indexFile(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), 'index.json')
}

async function readIndex(root: string, sessionId: string): Promise<SnapshotIndex> {
  try {
    const raw = await readFile(indexFile(root, sessionId), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as { start?: SnapshotRecord; bySeq?: Record<number, SnapshotRecord> }
      return {
        start: record.start,
        bySeq: record.bySeq ?? {},
      }
    }
  } catch {
    // missing or corrupt index → start fresh
  }
  return { bySeq: {} }
}

async function writeIndex(root: string, sessionId: string, index: SnapshotIndex): Promise<void> {
  const dir = sessionDir(root, sessionId)
  await mkdir(dir, { recursive: true })
  const temporary = join(dir, `index.json.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(index, null, 2), 'utf8')
  // Replace the index (remove first so Windows rename cannot fail on existing target).
  await rm(indexFile(root, sessionId), { force: true })
  await rename(temporary, indexFile(root, sessionId))
}

/** Recursively copy a workspace directory into a snapshot directory. */
async function copyWorkspace(src: string, dest: string, skipPrefix?: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const skip = skipPrefix === undefined ? undefined : resolvePath(skipPrefix)
  const isSkipped = (full: string): boolean =>
    skip !== undefined && (full === skip || full.startsWith(skip + sep))
  const entries = await readdir(src, { withFileTypes: true })
  const directories: { source: string; name: string }[] = []
  const files: { source: string; name: string }[] = []
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const source = join(src, entry.name)
    if (entry.isDirectory()) {
      // Never snapshot the snapshot store itself: if the snapshot root lives
      // inside the workspace, each capture would otherwise copy the previous
      // snapshots and grow without bound.
      if (isSkipped(resolvePath(source))) continue
      directories.push({ source, name: entry.name })
    } else if (entry.isFile()) {
      files.push({ source, name: entry.name })
    }
  }
  await forEachWithConcurrency(files, COPY_CONCURRENCY, async ({ source, name }) => {
    const target = join(dest, name)
    try {
      const info = await stat(source)
      if (info.size > MAX_SNAPSHOT_FILE_BYTES) {
        console.warn(`dsh-checkpoints: snapshot skipped large file (${info.size} bytes): ${source}`)
        return
      }
    } catch {
      // stat failed; let copyFile surface the real error.
    }
    await copyFile(source, target)
  })
  await forEachWithConcurrency(directories, 4, async ({ source, name }) => {
    await copyWorkspace(source, join(dest, name), skipPrefix)
  })
}

/** Copy one file from snapshot back into the workspace. */
async function restoreCopyFile(snapshotDir: string, cwd: string, relPath: string): Promise<void> {
  const source = join(snapshotDir, relPath)
  const target = join(cwd, relPath)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
}

/**
 * Move a file that should be deleted into a quarantine directory instead of
 * permanently removing it. Deletion is sensitive, so this gives the user a
 * chance to recover the file later from the snapshot root.
 */
async function quarantineFile(
  root: string | undefined,
  sessionId: string,
  cwd: string,
  relPath: string,
): Promise<string> {
  const snapshotRoot = root ?? defaultSnapshotRoot()
  const destDir = join(snapshotRoot, 'quarantine', safeSegment(sessionId), `${Date.now()}-${randomUUID()}`)
  const target = join(destDir, relPath)
  await mkdir(dirname(target), { recursive: true })
  const source = join(cwd, relPath)
  try {
    await rename(source, target)
  } catch {
    // Cross-device or locked file: copy then remove.
    await copyFile(source, target)
    await rm(source, { force: true })
  }
  return target
}

/** List files under a directory recursively, returning paths relative to root. */
async function listFiles(root: string, skipPrefix?: string): Promise<string[]> {
  const result: string[] = []
  const skip = skipPrefix === undefined ? undefined : resolvePath(skipPrefix)
  const isSkipped = (full: string): boolean =>
    skip !== undefined && (full === skip || full.startsWith(skip + sep))
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (isSkipped(resolvePath(full))) continue
        await walk(full, rel)
      } else if (entry.isFile()) result.push(rel)
    }
  }
  await walk(root, '')
  return result.sort()
}

/** Whether the relative path `rel` (against `cwd`) lies inside `skipPrefix`. */
function isInsideSkip(cwd: string, rel: string, skipPrefix?: string): boolean {
  if (skipPrefix === undefined) return false
  const full = resolvePath(cwd, rel)
  const skip = resolvePath(skipPrefix)
  return full === skip || full.startsWith(skip + sep)
}

/**
 * Shared diff loop: compare the files present in a snapshot directory against
 * a set of current relative paths (either a workspace walk or git's untracked
 * listing). Used by both the copy and hybrid diff paths.
 */
async function diffPathSets(
  snapshotDir: string,
  cwd: string,
  snapshotFiles: readonly string[],
  currentFiles: readonly string[],
): Promise<FileDiffStat[]> {
  const allPaths = new Set([...snapshotFiles, ...currentFiles])
  const stats: FileDiffStat[] = []
  for (const rel of allPaths) {
    const snapshotText = await readTextSafe(join(snapshotDir, rel))
    const currentText = await readTextSafe(join(cwd, rel))
    if (snapshotText === undefined && currentText === undefined) continue
    if (snapshotText === undefined) {
      const additions = currentText === undefined ? 0 : currentText.split('\n').length
      stats.push({ path: rel, additions, deletions: 0, status: 'added' })
    } else if (currentText === undefined) {
      const deletions = snapshotText.split('\n').length
      stats.push({ path: rel, additions: 0, deletions, status: 'deleted' })
    } else {
      const diff = countLineDiff(snapshotText, currentText)
      if (diff.additions > 0 || diff.deletions > 0) {
        stats.push({ path: rel, ...diff, status: 'modified' })
      }
    }
  }
  return stats.sort((a, b) => a.path.localeCompare(b.path))
}

/** A tiny line-diff counter. Returns added/deleted line counts. */
export function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 }
  // An empty text is zero lines, not one empty line (matches git and the
  // hunk differ in file-diff.ts).
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  const n = a.length
  const m = b.length
  if (n === 0) return { additions: m, deletions: 0 }
  if (m === 0) return { additions: 0, deletions: n }
  // Two-row LCS DP: O(m) memory instead of O(n*m). Time stays O(n*m), so cap
  // the cell count to avoid stalling on pathologically huge changed files.
  if (n * m > 100_000_000) return { additions: m, deletions: n }

  let prev = new Uint32Array(m + 1)
  let curr = new Uint32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]
    for (let j = 1; j <= m; j++) {
      curr[j] = ai === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  const lcs = prev[m]!
  return { additions: m - lcs, deletions: n - lcs }
}

async function readTextSafe(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Compare a copy snapshot directory against the current workspace. */
async function diffCopySnapshot(snapshotDir: string, cwd: string, skipPrefix?: string): Promise<FileDiffStat[]> {
  const snapshotFiles = await listFiles(snapshotDir)
  const currentFiles = await listFiles(cwd, skipPrefix)
  return diffPathSets(snapshotDir, cwd, snapshotFiles, currentFiles)
}

/** Compare a hybrid snapshot's untracked-file copy against current untracked files. */
async function diffUntrackedSnapshot(untrackedDir: string, cwd: string): Promise<FileDiffStat[]> {
  const snapshotFiles = await listFiles(untrackedDir)
  const currentUntracked = await listUntrackedFiles(cwd)
  return diffPathSets(untrackedDir, cwd, snapshotFiles, currentUntracked)
}

/** Return the repo-root-relative prefix of `cwd` (e.g. `sub/`), or ''. */
async function gitCwdPrefix(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-prefix'], execOptions)
    return stdout.trim()
  } catch {
    return ''
  }
}

/** Diff a git snapshot commit against the current working tree. */
async function diffGitSnapshot(cwd: string, commit: string): Promise<FileDiffStat[]> {
  try {
    const prefix = await gitCwdPrefix(cwd)
    const strip = (path: string): string =>
      prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path
    // Presence status (A/D/M) is not part of --numstat output; pull it from a
    // parallel --name-status run. Cosmetic: when it fails the list still works.
    const statuses = new Map<string, FileDiffStat['status']>()
    try {
      const { stdout } = await execFileAsync(
        'git', ['-C', cwd, 'diff', '--name-status', '-z', '--no-renames', commit, '--', '.'], execOptions,
      )
      const records = stdout.split('\0')
      // With --no-renames every entry is exactly `status\0path\0`.
      for (let i = 0; i + 1 < records.length; i += 2) {
        const status = records[i]
        const path = records[i + 1]
        if (status === undefined || path === undefined || status === '' || path === '') continue
        statuses.set(
          strip(path),
          status.startsWith('A') ? 'added' : status.startsWith('D') ? 'deleted' : 'modified',
        )
      }
    } catch {
      // keep going without statuses
    }
    // `-z`: NUL-separated records, paths never quoted (non-ASCII filenames
    // such as Chinese stay readable). `--no-renames`: renames are reported as
    // a delete+add pair of real paths, so every path is directly usable for
    // single-file undo.
    const { stdout } = await execFileAsync(
      'git', ['-C', cwd, 'diff', '--numstat', '-z', '--no-renames', commit, '--', '.'], execOptions,
    )
    const stats: FileDiffStat[] = []
    for (const record of stdout.split('\0')) {
      if (record === '') continue
      const parts = record.split('\t')
      if (parts.length < 3) continue
      const addedRaw = parts[0] ?? '-'
      const deletedRaw = parts[1] ?? '-'
      const binary = addedRaw === '-' || deletedRaw === '-'
      const additions = binary ? 0 : Number.parseInt(addedRaw, 10)
      const deletions = binary ? 0 : Number.parseInt(deletedRaw, 10)
      if (Number.isNaN(additions) || Number.isNaN(deletions)) continue
      const path = strip(parts.slice(2).join('\t'))
      const status = statuses.get(path)
      stats.push(binary
        ? { path, additions: 0, deletions: 0, binary: true, status }
        : { path, additions, deletions, status })
    }
    return stats.sort((a, b) => a.path.localeCompare(b.path))
  } catch {
    return []
  }
}

/**
 * Capture a snapshot of `cwd` for a checkpoint seq. Stores it in the session
 * index and returns the record (or undefined when there is no cwd).
 */
export async function captureSnapshot(
  root: string | undefined,
  sessionId: string,
  cwd: string | undefined,
  seq: number,
  isStart = false,
): Promise<SnapshotRecord | undefined> {
  if (!cwd) return undefined
  const snapshotRoot = root ?? defaultSnapshotRoot()
  const index = await readIndex(snapshotRoot, sessionId)
  if (isStart && index.start !== undefined) return index.start
  if (index.bySeq[seq] !== undefined) return index.bySeq[seq]

  // Hybrid strategy (VS Code-like):
  // - Git repositories: use a git snapshot for tracked files, plus a copy of
  //   untracked files so brand-new files are also detected and restorable.
  // - Non-Git workspaces: use a full copy snapshot.
  const id = randomUUID()
  let record: SnapshotRecord
  if (await isGitRepo(cwd)) {
    try {
      const commit = await createGitSnapshot(cwd)
      const untrackedDir = join(sessionDir(snapshotRoot, sessionId), 'snapshots', safeSegment(String(seq)), id, 'untracked')
      await copyUntrackedFiles(cwd, untrackedDir)
      await pinGitSnapshot(
        cwd,
        commit,
        `refs/dsh-checkpoints/${safeSegment(sessionId)}/${safeSegment(String(seq))}-${id.slice(0, 8)}`,
      )
      record = { kind: 'hybrid', id, time: Date.now(), commit, untrackedDir }
    } catch {
      // Git exists but cannot snapshot (e.g. no HEAD); fall back to full copy.
      const dir = join(sessionDir(snapshotRoot, sessionId), 'snapshots', safeSegment(String(seq)), id)
      await copyWorkspace(cwd, dir, snapshotRoot)
      record = { kind: 'copy', id, time: Date.now(), dir }
    }
  } else {
    const dir = join(sessionDir(snapshotRoot, sessionId), 'snapshots', safeSegment(String(seq)), id)
    await copyWorkspace(cwd, dir, snapshotRoot)
    record = { kind: 'copy', id, time: Date.now(), dir }
  }

  if (isStart) {
    await writeIndex(snapshotRoot, sessionId, { start: record, bySeq: { ...index.bySeq, [seq]: record } })
  } else {
    await writeIndex(snapshotRoot, sessionId, { start: index.start, bySeq: { ...index.bySeq, [seq]: record } })
  }
  return record
}

/** Resolve a snapshot record by seq or by the session-start marker. */
export async function getSnapshot(
  root: string | undefined,
  sessionId: string,
  seq?: number,
): Promise<SnapshotRecord | undefined> {
  const snapshotRoot = root ?? defaultSnapshotRoot()
  const index = await readIndex(snapshotRoot, sessionId)
  if (seq === undefined) return index.start
  return index.bySeq[seq] ?? index.start
}

/** Resolve the snapshot recorded for exactly this seq — no fallback. */
export async function getSnapshotStrict(
  root: string | undefined,
  sessionId: string,
  seq: number,
): Promise<SnapshotRecord | undefined> {
  const snapshotRoot = root ?? defaultSnapshotRoot()
  const index = await readIndex(snapshotRoot, sessionId)
  return index.bySeq[seq]
}

/** All checkpoint seqs that have their own snapshot, read in one pass. */
export async function listSnapshotSeqs(
  root: string | undefined,
  sessionId: string,
): Promise<Set<number>> {
  const snapshotRoot = root ?? defaultSnapshotRoot()
  const index = await readIndex(snapshotRoot, sessionId)
  return new Set(Object.keys(index.bySeq).map(Number))
}

/**
 * Read one file's content out of a snapshot record (the "old" side of a diff).
 *
 * Hybrid snapshots prefer the untracked-file copy (the file's state at
 * snapshot time even if it was untracked), then fall back to the pinned git
 * commit for tracked files. Returns undefined when the file did not exist in
 * the snapshot at all (a file created afterwards).
 */
export async function readSnapshotRecordFile(
  record: SnapshotRecord,
  cwd: string,
  relPath: string,
): Promise<string | undefined> {
  // `git show` and snapshot dirs always use '/'-separated paths.
  const gitPath = relPath.split('\\').join('/')
  if (record.kind === 'hybrid') {
    if (record.untrackedDir !== undefined) {
      const text = await readTextSafe(join(record.untrackedDir, relPath))
      if (text !== undefined) return text
    }
    if (record.commit !== undefined) return readGitBlob(cwd, record.commit, gitPath)
    return undefined
  }
  if (record.kind === 'git') {
    if (record.commit === undefined) return undefined
    return readGitBlob(cwd, record.commit, gitPath)
  }
  if (record.dir === undefined) return undefined
  return readTextSafe(join(record.dir, relPath))
}

/** Read the current workspace copy of one file (the "new" side of a diff). */
export async function readWorkspaceFile(cwd: string, relPath: string): Promise<string | undefined> {
  return readTextSafe(join(cwd, relPath))
}

/** Read a blob's text out of a git commit (`<commit>:<path>`); undefined when absent. */
async function readGitBlob(cwd: string, commit: string, gitPath: string): Promise<string | undefined> {
  try {
    const prefix = await gitCwdPrefix(cwd)
    const { stdout } = await execFileAsync(
      'git', ['-C', cwd, 'show', `${commit}:${prefix}${gitPath}`], execOptions,
    )
    return stdout
  } catch {
    return undefined
  }
}

/** Whether a snapshot exists for exactly this checkpoint seq. */
export async function hasSnapshotAt(
  root: string | undefined,
  sessionId: string,
  seq: number,
): Promise<boolean> {
  const snapshotRoot = root ?? defaultSnapshotRoot()
  const index = await readIndex(snapshotRoot, sessionId)
  return index.bySeq[seq] !== undefined
}

/** Restore all files (or one file) from a snapshot into `cwd`. */
export async function restoreSnapshot(
  root: string | undefined,
  sessionId: string,
  cwd: string,
  seq?: number,
  relPath?: string,
  options?: { deleteNewFiles?: boolean },
): Promise<void> {
  // Strict resolution: restoring files to the wrong baseline silently would
  // be far worse than failing, so a missing per-checkpoint snapshot is an
  // error instead of a silent fall back to the session-start snapshot.
  const snapshotRoot = root ?? defaultSnapshotRoot()
  const index = await readIndex(snapshotRoot, sessionId)
  const record = seq === undefined ? index.start : index.bySeq[seq]
  if (record === undefined) {
    throw new Error(seq === undefined
      ? 'no session-start file snapshot available'
      : `no file snapshot available for checkpoint ${seq}`)
  }

  if (record.kind === 'git') {
    if (record.commit === undefined) throw new Error('git snapshot is missing commit id')
    const pathspec = relPath === undefined ? '.' : relPath
    await execFileAsync(
      'git',
      ['-C', cwd, 'restore', '--worktree', `--source=${record.commit}`, '--', pathspec],
      execOptions,
    )
    return
  }

  if (record.kind === 'hybrid') {
    if (relPath === undefined) {
      if (record.commit !== undefined) {
        await execFileAsync(
          'git',
          ['-C', cwd, 'restore', '--worktree', `--source=${record.commit}`, '--', '.'],
          execOptions,
        )
      }
      if (record.untrackedDir !== undefined) {
        const files = await listFiles(record.untrackedDir)
        for (const file of files) {
          await restoreCopyFile(record.untrackedDir, cwd, file)
        }
      }
      if (options?.deleteNewFiles === true) {
        const snapshotUntracked = new Set(record.untrackedDir === undefined ? [] : await listFiles(record.untrackedDir))
        const currentUntracked = (await listUntrackedFiles(cwd))
          .filter((file) => !isInsideSkip(cwd, file, snapshotRoot))
        for (const file of currentUntracked) {
          if (!snapshotUntracked.has(file)) {
            await quarantineFile(root, sessionId, cwd, file)
          }
        }
      }
      return
    }

    // Single-file undo in a hybrid snapshot: prefer the untracked copy, then
    // git restore for tracked files, then quarantine a file that was created
    // after the checkpoint (deletion is recoverable).
    if (record.untrackedDir !== undefined) {
      const sourcePath = join(record.untrackedDir, relPath)
      if (await pathExists(sourcePath)) {
        await restoreCopyFile(record.untrackedDir, cwd, relPath)
        return
      }
    }
    if (record.commit !== undefined) {
      try {
        await execFileAsync(
          'git',
          ['-C', cwd, 'restore', '--worktree', `--source=${record.commit}`, '--', relPath],
          execOptions,
        )
        return
      } catch {
        // fall through to quarantine of a new untracked file
      }
    }
    await quarantineFile(root, sessionId, cwd, relPath)
    return
  }

  if (record.dir === undefined) throw new Error('copy snapshot is missing directory')
  if (relPath === undefined) {
    const snapshotFiles = await listFiles(record.dir)
    for (const file of snapshotFiles) {
      await restoreCopyFile(record.dir, cwd, file)
    }
    if (options?.deleteNewFiles === true) {
      const snapshotSet = new Set(snapshotFiles)
      const currentFiles = await listFiles(cwd, snapshotRoot)
      for (const file of currentFiles) {
        if (!snapshotSet.has(file)) {
          await quarantineFile(root, sessionId, cwd, file)
        }
      }
    }
  } else {
    const sourcePath = join(record.dir, relPath)
    if (await pathExists(sourcePath)) {
      await restoreCopyFile(record.dir, cwd, relPath)
    } else {
      // The file did not exist at the snapshot: undoing means quarantining
      // the file that was created after the checkpoint.
      await quarantineFile(root, sessionId, cwd, relPath)
    }
  }
}

/** Compute per-file diff stats between a snapshot and the current workspace. */
export async function diffSnapshotToWorkspace(
  root: string | undefined,
  sessionId: string,
  cwd: string,
  seq?: number,
): Promise<FileDiffStat[]> {
  const record = await getSnapshot(root, sessionId, seq)
  if (record === undefined) return []
  if (record.kind === 'git' && record.commit !== undefined) {
    return diffGitSnapshot(cwd, record.commit)
  }
  if (record.kind === 'hybrid' && record.commit !== undefined) {
    const tracked = await diffGitSnapshot(cwd, record.commit)
    const untracked = record.untrackedDir === undefined
      ? []
      : await diffUntrackedSnapshot(record.untrackedDir, cwd)
    const byPath = new Map<string, FileDiffStat>()
    for (const stat of [...tracked, ...untracked]) {
      const existing = byPath.get(stat.path)
      byPath.set(stat.path, existing === undefined
        ? stat
        : { path: stat.path, additions: existing.additions + stat.additions, deletions: existing.deletions + stat.deletions })
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  }
  if (record.kind === 'copy' && record.dir !== undefined) {
    return diffCopySnapshot(record.dir, cwd)
  }
  return []
}

/** Whether a path exists (used for copy restore safety). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Ensure the snapshot root exists. */
export async function ensureRoot(root: string | undefined): Promise<string> {
  const snapshotRoot = root ?? defaultSnapshotRoot()
  await mkdir(snapshotRoot, { recursive: true })
  return snapshotRoot
}

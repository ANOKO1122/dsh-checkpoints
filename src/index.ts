/**
 * Host half of dsh-checkpoints.
 *
 * Provides same-origin HTTP routes used by the web client:
 *
 *   GET  /plugins/dsh-checkpoints/list?sessionId=<id>
 *        → current visible user-instruction checkpoints
 *   GET  /plugins/dsh-checkpoints/diff?sessionId=<id>&baseline=checkpoint|session
 *        → per-file +/− line stats between a snapshot and the workspace
 *   GET  /plugins/dsh-checkpoints/file-diff?sessionId=<id>&path=<rel>&baseline=...
 *        → the actual unified-diff hunks of one file (snapshot vs workspace)
 *   POST /plugins/dsh-checkpoints/rewind  { sessionId, seq }
 *        → roll the visible conversation back to that checkpoint
 *   POST /plugins/dsh-checkpoints/recall  { sessionId, seq }
 *        → remove that instruction and everything after it, returning its text
 *          so the client can put it back into the composer for editing
 *
 * The heavy lifting is in `domain.ts`; this file only adapts HTTP ↔ Session.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'
import { foldSurface } from '@deepseek-ai/dsh-session/surface'
import type {} from '@deepseek-ai/dsh-agent'
import { listCheckpoints, recallUserMessage, rewindToCheckpoint } from './domain.ts'
import { diffToHunks, looksBinary, MAX_DIFF_TEXT_CHARS } from './file-diff.ts'
import {
  captureSnapshot,
  diffSnapshotToWorkspace,
  ensureRoot,
  getSnapshot,
  getSnapshotStrict,
  listSnapshotSeqs,
  readSnapshotRecordFile,
  readWorkspaceFile,
  restoreSnapshot,
} from './file-snapshot.ts'

/** Structural slice of the web server service (rc.1 httpServer / later webServer). */
interface WebRouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const

export const name = 'dsh-checkpoints'
export const inject = ['sessions', 'agents']

/** Plugin configuration. */
export interface Config {
  /** URL prefix under which the plugin routes are served. */
  routePrefix?: string
  /** Root directory for file snapshots (default: $DSH_HOME/dsh-checkpoints). */
  snapshotRoot?: string
}

export const Config: z<Config> = z.object({
  routePrefix: z.string().default('/plugins/dsh-checkpoints'),
  snapshotRoot: z.string()
    .comment('Root directory for file snapshots; leave unset for $DSH_HOME/dsh-checkpoints'),
})

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function sendError(res: ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  sendJson(res, status, {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  })
}

/** Read a bounded JSON request body. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sessionIdOf(value: unknown): SessionId | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return value as SessionId
}

function isSafeRelPath(value: string): boolean {
  if (value === '' || isAbsolute(value)) return false
  const segments = value.split(/[\\/]+/)
  return segments.every((segment) => segment !== '..' && segment !== '')
}

/** Seq of the latest visible user instruction (the "最近检查点" baseline). */
function latestCheckpointSeq(session: Session): number | undefined {
  const checkpoints = listCheckpoints(session)
  return checkpoints[checkpoints.length - 1]?.seq
}

/**
 * Resolve the baseline for diff routes: `checkpoint` diffs against the latest
 * user instruction's snapshot, `session` against the session-start snapshot.
 * `degraded` marks a checkpoint baseline without its own snapshot (the diff
 * falls back to the session-start snapshot).
 */
async function resolveBaseline(
  root: string,
  sessionId: string,
  session: Session,
  baseline: 'checkpoint' | 'session',
): Promise<{ seq?: number; degraded: boolean }> {
  if (baseline === 'session') {
    return { seq: undefined, degraded: false }
  }
  const seq = latestCheckpointSeq(session)
  if (seq === undefined) return { seq: undefined, degraded: false }
  const strict = await getSnapshotStrict(root, sessionId, seq)
  return { seq, degraded: strict === undefined }
}

export function apply(ctx: Context, config: Config): void {
  const routePrefix = config.routePrefix ?? '/plugins/dsh-checkpoints'
  const snapshotRoot = config.snapshotRoot

  // Serialize snapshot capture per session so concurrent user messages cannot
  // corrupt the JSON index.
  const snapshotLocks = new Map<string, Promise<unknown>>()
  const lockWaiters = new Map<string, number>()
  const withSnapshotLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    lockWaiters.set(key, (lockWaiters.get(key) ?? 0) + 1)
    const previous = snapshotLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const chain = previous.then(() => gate)
    snapshotLocks.set(key, chain)
    return previous.then(() => fn()).finally(() => {
      release()
      const remaining = (lockWaiters.get(key) ?? 1) - 1
      if (remaining <= 0) {
        // No queued work: drop the session's entry so the maps stay bounded.
        lockWaiters.delete(key)
        snapshotLocks.delete(key)
      } else {
        lockWaiters.set(key, remaining)
      }
    })
  }

  // Capture a file snapshot each time the user sends a real instruction.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
    // Only real appended user instructions become file checkpoints; surface
    // replacement copies (created by rewind/recall) are handled explicitly.
    if (event.surfaceOp !== 'append') return
    const cwd = session.header.cwd
    if (!cwd) return
    void withSnapshotLock(session.id, async () => {
      try {
        const root = await ensureRoot(snapshotRoot)
        const start = await getSnapshot(root, session.id)
        await captureSnapshot(root, session.id, cwd, event.seq, start === undefined)
      } catch (error: unknown) {
        ctx.logger.warn(`dsh-checkpoints: snapshot capture failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  })

  let webRegistered = false
  const registerRoutes = (): void => {
    if (webRegistered) return
    const web = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])) as WebRouteHost | undefined
    if (web === undefined) return
    webRegistered = true

    const routeHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const url = new URL(req.url ?? '/', 'http://dsh.local')
        const path = url.pathname

        if (req.method === 'GET' && path === `${routePrefix}/list`) {
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          if (sessionId === undefined) {
            sendError(res, 400, 'BAD_REQUEST', 'missing sessionId')
            return
          }
          const session = ctx.sessions.get(sessionId)
          if (session === undefined) {
            sendError(res, 404, 'SESSION_NOT_FOUND', `session "${sessionId}" not found`)
            return
          }
          let checkpoints = listCheckpoints(session).map((checkpoint) => ({ ...checkpoint, hasSnapshot: false }))
          try {
            // One index read answers every checkpoint; per-checkpoint reads
            // would re-parse the same JSON N times.
            const root = await ensureRoot(snapshotRoot)
            const snapshotSeqs = await listSnapshotSeqs(root, sessionId)
            checkpoints = checkpoints.map((checkpoint) => ({
              ...checkpoint,
              hasSnapshot: snapshotSeqs.has(checkpoint.seq),
            }))
          } catch (error: unknown) {
            ctx.logger.warn(`dsh-checkpoints: snapshot metadata unavailable: ${error instanceof Error ? error.message : String(error)}`)
          }
          sendJson(res, 200, { ok: true, value: { checkpoints } })
          return
        }

        if (req.method === 'GET' && path === `${routePrefix}/surface`) {
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          if (sessionId === undefined) {
            sendError(res, 400, 'BAD_REQUEST', 'missing sessionId')
            return
          }
          const session = ctx.sessions.get(sessionId)
          if (session === undefined) {
            sendError(res, 404, 'SESSION_NOT_FOUND', `session "${sessionId}" not found`)
            return
          }
          const shadowedSeqs: number[] = []
          try {
            const folded = foldSurface(session.events)
            for (const replacement of folded.replacements) {
              shadowedSeqs.push(...replacement.shadowedSeqs)
            }
          } catch (error: unknown) {
            ctx.logger.warn(`dsh-checkpoints: surface fold unavailable: ${error instanceof Error ? error.message : String(error)}`)
            sendError(res, 422, 'SURFACE_FOLD_FAILED', error instanceof Error ? error.message : String(error))
            return
          }
          sendJson(res, 200, { ok: true, value: { shadowedSeqs } })
          return
        }

        if (req.method === 'GET' && path === `${routePrefix}/diff`) {
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          if (sessionId === undefined) {
            sendError(res, 400, 'BAD_REQUEST', 'missing sessionId')
            return
          }
          const baseline = url.searchParams.get('baseline') === 'session' ? 'session' : 'checkpoint'
          const session = ctx.sessions.get(sessionId)
          if (session === undefined) {
            sendError(res, 404, 'SESSION_NOT_FOUND', `session "${sessionId}" not found`)
            return
          }
          const cwd = session.header.cwd
          if (!cwd) {
            sendJson(res, 200, { ok: true, value: { baseline, files: [], totalAdditions: 0, totalDeletions: 0 } })
            return
          }
          let files: Awaited<ReturnType<typeof diffSnapshotToWorkspace>> = []
          let degraded = false
          try {
            const root = await ensureRoot(snapshotRoot)
            if (baseline === 'checkpoint') {
              degraded = (await resolveBaseline(root, sessionId, session, baseline)).degraded
            }
            files = await diffSnapshotToWorkspace(root, sessionId, cwd, baseline === 'session' ? undefined : latestCheckpointSeq(session))
          } catch (error: unknown) {
            ctx.logger.warn(`dsh-checkpoints: diff unavailable: ${error instanceof Error ? error.message : String(error)}`)
          }
          const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0)
          const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0)
          sendJson(res, 200, { ok: true, value: { baseline, degraded, files, totalAdditions, totalDeletions } })
          return
        }

        if (req.method === 'GET' && path === `${routePrefix}/file-diff`) {
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          if (sessionId === undefined) {
            sendError(res, 400, 'BAD_REQUEST', 'missing sessionId')
            return
          }
          const relPath = url.searchParams.get('path')
          if (relPath === null || !isSafeRelPath(relPath)) {
            sendError(res, 400, 'BAD_REQUEST', 'missing or invalid path')
            return
          }
          const baseline = url.searchParams.get('baseline') === 'session' ? 'session' : 'checkpoint'
          const session = ctx.sessions.get(sessionId)
          if (session === undefined) {
            sendError(res, 404, 'SESSION_NOT_FOUND', `session "${sessionId}" not found`)
            return
          }
          const cwd = session.header.cwd
          if (!cwd) {
            sendJson(res, 200, {
              ok: true,
              value: { path: relPath, baseline, degraded: false, binary: false, tooLarge: false, additions: 0, deletions: 0, hunks: [] },
            })
            return
          }
          try {
            const root = await ensureRoot(snapshotRoot)
            const { seq, degraded } = await resolveBaseline(root, sessionId, session, baseline)
            const record = await getSnapshot(root, sessionId, seq)
            if (record === undefined) {
              // No snapshot at all: nothing to compare against.
              sendJson(res, 200, {
                ok: true,
                value: { path: relPath, baseline, degraded: true, binary: false, tooLarge: false, additions: 0, deletions: 0, hunks: [] },
              })
              return
            }
            const [oldText, newText] = await Promise.all([
              readSnapshotRecordFile(record, cwd, relPath),
              readWorkspaceFile(cwd, relPath),
            ])
            if (oldText === undefined && newText === undefined) {
              sendError(res, 404, 'FILE_NOT_FOUND', `file "${relPath}" exists neither in the snapshot nor in the workspace`)
              return
            }
            if ((oldText !== undefined && looksBinary(oldText)) || (newText !== undefined && looksBinary(newText))) {
              sendJson(res, 200, {
                ok: true,
                value: { path: relPath, baseline, degraded, binary: true, tooLarge: false, additions: 0, deletions: 0, hunks: [] },
              })
              return
            }
            if ((oldText?.length ?? 0) > MAX_DIFF_TEXT_CHARS || (newText?.length ?? 0) > MAX_DIFF_TEXT_CHARS) {
              sendJson(res, 200, {
                ok: true,
                value: { path: relPath, baseline, degraded, binary: false, tooLarge: true, additions: 0, deletions: 0, hunks: [] },
              })
              return
            }
            const result = diffToHunks(oldText ?? '', newText ?? '')
            sendJson(res, 200, {
              ok: true,
              value: { path: relPath, baseline, degraded, binary: false, tooLarge: false, ...result },
            })
          } catch (error: unknown) {
            ctx.logger.warn(`dsh-checkpoints: file diff unavailable: ${error instanceof Error ? error.message : String(error)}`)
            sendError(res, 422, 'FILE_DIFF_FAILED', error instanceof Error ? error.message : String(error))
          }
          return
        }

        if (req.method === 'POST' && (path === `${routePrefix}/rewind` || path === `${routePrefix}/recall` || path === `${routePrefix}/undo-file`)) {
          // Same-origin guard for state-changing routes: a cross-site page can
          // issue "simple" POSTs without a CORS preflight, so the content type
          // and Origin are verified explicitly. undo-file writes to the
          // workspace, so this is not just paranoia.
          const contentType = String(req.headers['content-type'] ?? '')
          if (!contentType.includes('application/json')) {
            sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json')
            return
          }
          const origin = req.headers.origin
          if (typeof origin === 'string' && origin !== '') {
            const host = req.headers.host
            let sameOrigin = false
            if (typeof host === 'string' && host !== '') {
              try {
                sameOrigin = new URL(origin).host === host
              } catch {
                sameOrigin = false
              }
            }
            if (!sameOrigin) {
              sendError(res, 403, 'FORBIDDEN_ORIGIN', 'cross-origin requests are not allowed')
              return
            }
          }
          let payload: unknown
          try {
            payload = await readJsonBody(req)
          } catch {
            sendError(res, 400, 'BAD_REQUEST', 'request body must be valid JSON')
            return
          }
          if (!isRecord(payload)) {
            sendError(res, 400, 'BAD_REQUEST', 'request body must be a JSON object')
            return
          }
          const sessionId = sessionIdOf(payload.sessionId)
          if (sessionId === undefined) {
            sendError(res, 400, 'BAD_REQUEST', 'missing sessionId')
            return
          }
          const session = ctx.sessions.get(sessionId)
          if (session === undefined) {
            sendError(res, 404, 'SESSION_NOT_FOUND', `session "${sessionId}" not found`)
            return
          }
          const agent = ctx.agents.get(sessionId)
          if (agent !== undefined && agent.status === 'running') {
            sendError(res, 409, 'AGENT_BUSY', `session "${sessionId}" is running; stop the current turn before changing checkpoints`, { sessionId })
            return
          }
          const cwd = session.header.cwd

          try {
            if (path === `${routePrefix}/undo-file`) {
              const relPath = payload.path
              if (typeof relPath !== 'string' || !isSafeRelPath(relPath)) {
                sendError(res, 400, 'BAD_REQUEST', 'missing or invalid path')
                return
              }
              const baseline = payload.baseline === 'session' ? 'session' : 'checkpoint'
              if (!cwd) {
                sendError(res, 400, 'NO_CWD', 'session has no working directory for file undo')
                return
              }
              const root = await ensureRoot(snapshotRoot)
              const checkpoints = listCheckpoints(session)
              const latest = checkpoints[checkpoints.length - 1]
              const seq = baseline === 'session' ? undefined : latest?.seq
              await restoreSnapshot(root, sessionId, cwd, seq, relPath)
              sendJson(res, 200, { ok: true, value: { path: relPath } })
              return
            }

            const seq = payload.seq
            if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
              sendError(res, 400, 'BAD_REQUEST', 'missing or invalid seq')
              return
            }

            if (path === `${routePrefix}/rewind`) {
              const event = rewindToCheckpoint(session, seq)
              await ctx.sessions.flush(session)
              // The conversation rewrite has committed above; a file rollback
              // problem must not be reported as a rejected rewrite.
              let filesRestored = true
              let fileError: string | undefined
              if (payload.rollbackFiles === true && cwd) {
                try {
                  const root = await ensureRoot(snapshotRoot)
                  await restoreSnapshot(
                    root,
                    sessionId,
                    cwd,
                    seq,
                    undefined,
                    { deleteNewFiles: payload.deleteNewFiles === true },
                  )
                } catch (error: unknown) {
                  filesRestored = false
                  fileError = error instanceof Error ? error.message : String(error)
                  ctx.logger.warn(`dsh-checkpoints: file rollback failed after rewind: ${fileError}`)
                }
              }
              // Record a fresh file snapshot at the rewind point so the new
              // checkpoint also has file state to compare/restore against.
              if (cwd) {
                try {
                  await withSnapshotLock(sessionId, async () => {
                    const root = await ensureRoot(snapshotRoot)
                    const start = await getSnapshot(root, sessionId)
                    await captureSnapshot(root, sessionId, cwd, event.seq, start === undefined)
                  })
                } catch (error: unknown) {
                  ctx.logger.warn(`dsh-checkpoints: post-rewind snapshot capture failed: ${error instanceof Error ? error.message : String(error)}`)
                }
              }
              sendJson(res, 200, {
                ok: true,
                value: {
                  seq: event.seq,
                  filesRestored,
                  ...(fileError === undefined ? {} : { fileError }),
                },
              })
            } else {
              const { removedText, event } = recallUserMessage(session, seq)
              await ctx.sessions.flush(session)
              let filesRestored = true
              let fileError: string | undefined
              if (payload.rollbackFiles === true && cwd) {
                try {
                  const root = await ensureRoot(snapshotRoot)
                  await restoreSnapshot(
                    root,
                    sessionId,
                    cwd,
                    seq,
                    undefined,
                    { deleteNewFiles: payload.deleteNewFiles === true },
                  )
                } catch (error: unknown) {
                  filesRestored = false
                  fileError = error instanceof Error ? error.message : String(error)
                  ctx.logger.warn(`dsh-checkpoints: file rollback failed after recall: ${fileError}`)
                }
              }
              sendJson(res, 200, {
                ok: true,
                value: {
                  seq: event.seq,
                  removedText,
                  filesRestored,
                  ...(fileError === undefined ? {} : { fileError }),
                },
              })
            }
          } catch (error: unknown) {
            ctx.logger.warn(`dsh-checkpoints: ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
            sendError(res, 422, 'REWRITE_REJECTED', error instanceof Error ? error.message : String(error), { sessionId, seq: payload.seq })
          }
          return
        }

        sendError(res, 404, 'NOT_FOUND', `no dsh-checkpoints route for ${req.method ?? ''} ${path}`)
    }

    for (const routePath of [
      `${routePrefix}/list`,
      `${routePrefix}/surface`,
      `${routePrefix}/diff`,
      `${routePrefix}/file-diff`,
      `${routePrefix}/rewind`,
      `${routePrefix}/recall`,
      `${routePrefix}/undo-file`,
    ]) {
      ctx.effect(() => web.register({
        kind: 'exact',
        path: routePath,
        handler: routeHandler,
      }), `dsh-checkpoints: route ${routePath}`)
    }
  }

  registerRoutes()
  ctx.on('internal/service', (serviceName) => {
    if ((WEB_SERVER_KEYS as readonly string[]).includes(serviceName)) {
      registerRoutes()
    }
  })
}

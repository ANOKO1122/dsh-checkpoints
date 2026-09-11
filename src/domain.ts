/**
 * Pure conversation-checkpoint operations for dsh-checkpoints.
 *
 * DSH session logs are append-only. This plugin never rewrites or deletes
 * old events; it appends user instructions or plugin-owned `user/message` notices with a
 * `surfaceOp: { op: 'replace', ... }` marker so the *visible* model surface
 * collapses to the requested checkpoint. The original events stay in the log,
 * which is the DSH-sanctioned way to implement a "rewind" without mutating
 * durable history.
 */

import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'

/** One checkpoint row shown in the UI. */
export interface Checkpoint {
  /** Surface seq of the user message. */
  readonly seq: number
  /** Event timestamp (epoch ms). */
  readonly time: number
  /** Plain-text preview of the instruction. */
  readonly text: string
}

/** Extract plain text from a user message's content blocks. */
export function textOfUserMessage(event: SessionEvent<'user/message'>): string {
  const blocks = event.data.content
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * List every visible real user instruction (checkpoint) in surface order.
 * Replacement copies created by this plugin use `source.kind === 'user'`, so
 * they keep appearing as normal user checkpoints.
 */
export function listCheckpoints(session: Session): Checkpoint[] {
  const result: Checkpoint[] = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event === undefined || event.type !== 'user/message') continue
    if (event.data.source.kind !== 'user') continue
    result.push({ seq, time: event.time, text: textOfUserMessage(event) })
  }
  return result
}

/** Replace the surface range `[startSeq, endSeq]` with a new user message. */
function replaceRangeWithUser(
  session: Session,
  startSeq: SessionSeq,
  endSeq: SessionSeq,
  shadowedSeqs: readonly SessionSeq[],
  content: readonly ContentBlock[],
): SessionEvent<'user/message'> {
  const message = createUserMessage({
    content: [...content],
    source: { kind: 'user' },
  })
  return session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: shadowedSeqs.slice(),
  })
}

/**
 * Between-turn recall uses user-role plugin context: system and assistant
 * events require an open step. This nonempty notice is provider-compatible,
 * is not a user checkpoint, and does not wake a model run.
 */
function replaceRangeWithRecallNotice(
  session: Session,
  startSeq: SessionSeq,
  endSeq: SessionSeq,
  shadowedSeqs: readonly SessionSeq[],
): SessionEvent<'user/message'> {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '[dsh-checkpoints: the user recalled the following conversation range. Await the next user instruction.]' }],
    source: { kind: 'plugin', plugin: 'dsh-checkpoints', form: 'notice', summary: '已撤回消息及其后续对话' },
  }), {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: shadowedSeqs.slice(),
  })
}
/**
 * Roll the visible conversation back to a checkpoint: keep that user
 * instruction as the last visible message and shadow everything after it.
 *
 * @returns the appended replacement event.
 */
export function rewindToCheckpoint(session: Session, checkpointSeq: number): SessionEvent<'user/message'> {
  const targetSeq = SessionSeq(checkpointSeq)
  const nodes = [...session.surface.nodes]
  const startIndex = nodes.indexOf(targetSeq)
  if (startIndex === -1) {
    const retried = retryReplacement(session, targetSeq, 'rewind')
    if (retried?.type === 'user/message') return retried
    throw new Error(`checkpoint ${checkpointSeq} is not in the current visible conversation`)
  }
  const target = session.eventAt(targetSeq)
  if (target === undefined || target.type !== 'user/message' || target.data.source.kind !== 'user') {
    throw new Error(`checkpoint ${checkpointSeq} is not a real user instruction`)
  }
  const endSeq = nodes[nodes.length - 1]
  if (endSeq === undefined) throw new Error('conversation has no visible messages')
  return replaceRangeWithUser(
    session,
    targetSeq,
    endSeq,
    nodes.slice(startIndex),
    target.data.content,
  )
}

/**
 * Recall (remove) one user instruction and everything after it, returning the
 * removed instruction text so the UI can put it back into the composer for
 * editing. This is the "edit a sent message" path.
 *
 * A plugin notice replaces the range without fabricating an execution step.
 * Original messages remain in the append-only log, not the active surface.
 */
export function recallUserMessage(
  session: Session,
  checkpointSeq: number,
): { removedText: string; event: SessionEvent<'user/message'> | SessionEvent<'system/message'> } {
  const targetSeq = SessionSeq(checkpointSeq)
  const nodes = [...session.surface.nodes]
  const targetIndex = nodes.indexOf(targetSeq)
  if (targetIndex === -1) {
    const retried = retryReplacement(session, targetSeq, 'recall')
    const original = session.eventAt(targetSeq)
    if ((retried?.type === 'system/message' || retried?.type === 'user/message') && original?.type === 'user/message') {
      return { removedText: textOfUserMessage(original), event: retried }
    }
    throw new Error(`checkpoint ${checkpointSeq} is not in the current visible conversation`)
  }
  const target = session.eventAt(targetSeq)
  if (target === undefined || target.type !== 'user/message' || target.data.source.kind !== 'user') {
    throw new Error(`checkpoint ${checkpointSeq} is not a real user instruction`)
  }
  const removedText = textOfUserMessage(target)
  const endSeq = nodes.at(-1)
  if (endSeq === undefined) throw new Error('conversation has no visible messages')

  const event = replaceRangeWithRecallNotice(
    session,
    targetSeq,
    endSeq,
    nodes.slice(targetIndex),
  )
  return { removedText, event }
}

/** Retry only the exact terminal replacement; never resurrect a stale branch. */
function retryReplacement(session: Session, targetSeq: SessionSeq, mode: 'recall' | 'rewind'): SessionEvent | undefined {
  const tailSeq = session.surface.nodes.at(-1)
  if (tailSeq === undefined) return undefined
  const tail = session.eventAt(tailSeq)
  const original = session.eventAt(targetSeq)
  if (original?.type !== 'user/message' || original.data.source.kind !== 'user') return undefined
  if (!tail || typeof tail.surfaceOp !== 'object' || tail.surfaceOp.op !== 'replace'
    || tail.surfaceOp.startSeq !== targetSeq || !tail.sourceEventSeqs?.includes(targetSeq)) return undefined
  if (mode === 'recall' && tail.type === 'system/message') {
    const message = tail.data.message
    if (message.source.kind === 'plugin' && message.source.plugin === 'dsh-checkpoints'
      && message.content.every(block => block.type === 'text' && block.text === '')) return tail
  }
  if (mode === 'recall' && tail.type === 'user/message'
    && tail.data.source.kind === 'plugin' && tail.data.source.plugin === 'dsh-checkpoints') return tail
  if (mode === 'rewind' && tail.type === 'user/message' && tail.data.source.kind === 'user'
    && JSON.stringify(tail.data.content) === JSON.stringify(original.data.content)) return tail
  return undefined
}

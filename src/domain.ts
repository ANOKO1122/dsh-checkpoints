/**
 * Pure conversation-checkpoint operations for dsh-checkpoints.
 *
 * DSH session logs are append-only. This plugin never rewrites or deletes
 * old events; it appends `user/message` / `assistant/message` events with a
 * `surfaceOp: { op: 'replace', ... }` marker so the *visible* model surface
 * collapses to the requested checkpoint. The original events stay in the log,
 * which is the DSH-sanctioned way to implement a "rewind" without mutating
 * durable history.
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'

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
    const event = session.events[seq]
    if (event === undefined || event.type !== 'user/message') continue
    if (event.data.source.kind !== 'user') continue
    result.push({ seq, time: event.time, text: textOfUserMessage(event) })
  }
  return result
}

/** Replace the surface range `[startSeq, endSeq]` with a new user message. */
function replaceRangeWithUser(
  session: Session,
  startSeq: number,
  endSeq: number,
  shadowedSeqs: readonly number[],
  content: readonly ContentBlock[],
): SessionEvent<'user/message'> {
  const message = createUserMessage({
    content: [...content],
    source: { kind: 'user' },
  })
  return session.append('user/message', message, {
    surfaceOp: { op: 'replace', start: startSeq, end: endSeq },
    sourceEventSeqs: [...shadowedSeqs],
  })
}

/** Replace the surface range with a copy of an existing assistant message. */
function replaceRangeWithAssistant(
  session: Session,
  anchor: SessionEvent<'assistant/message'>,
  startSeq: number,
  endSeq: number,
  shadowedSeqs: readonly number[],
): SessionEvent<'assistant/message'> {
  const data = anchor.data
  const message = createAssistantMessage({
    content: [...data.message.content],
    source: {
      provider: data.message.source.provider,
      model: data.message.source.model,
      ...(data.message.source.replayState === undefined ? {} : { replayState: data.message.source.replayState }),
    },
  })
  return session.append('assistant/message', {
    turn: data.turn,
    step: data.step,
    message,
    ...(data.usage === undefined ? {} : { usage: data.usage }),
  }, {
    surfaceOp: { op: 'replace', start: startSeq, end: endSeq },
    sourceEventSeqs: [...shadowedSeqs],
  })
}

/**
 * Replace the surface range with an empty assistant message.
 *
 * This is the "delete to empty" fallback for recalling the first visible
 * message: a surface replacement must insert one node, and when there is no
 * earlier user/assistant message to copy as the anchor, an empty assistant
 * message still satisfies the fold. Because empty assistant messages derive to
 * no model-visible message, the resulting transcript is empty and the chat view
 * renders nothing for the replacement node.
 */
function replaceRangeWithEmptyAssistant(
  session: Session,
  startSeq: number,
  endSeq: number,
  shadowedSeqs: readonly number[],
): SessionEvent<'assistant/message'> {
  const message = createAssistantMessage({
    content: [],
    source: {
      provider: 'dsh-checkpoints',
      model: 'recall-empty',
    },
  })
  return session.append('assistant/message', {
    turn: 0,
    step: 0,
    message,
  }, {
    surfaceOp: { op: 'replace', start: startSeq, end: endSeq },
    sourceEventSeqs: [...shadowedSeqs],
  })
}

/**
 * Roll the visible conversation back to a checkpoint: keep that user
 * instruction as the last visible message and shadow everything after it.
 *
 * @returns the appended replacement event.
 */
export function rewindToCheckpoint(session: Session, checkpointSeq: number): SessionEvent<'user/message'> {
  const nodes = [...session.surface.nodes]
  const startIndex = nodes.indexOf(checkpointSeq)
  if (startIndex === -1) {
    throw new Error(`checkpoint ${checkpointSeq} is not in the current visible conversation`)
  }
  const target = session.events[checkpointSeq]
  if (target === undefined || target.type !== 'user/message' || target.data.source.kind !== 'user') {
    throw new Error(`checkpoint ${checkpointSeq} is not a real user instruction`)
  }
  const endSeq = nodes[nodes.length - 1]
  if (endSeq === undefined) throw new Error('conversation has no visible messages')
  return replaceRangeWithUser(
    session,
    checkpointSeq,
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
 * Implementation detail: because a surface replacement must insert one node,
 * the rewrite is anchored at the closest earlier user/assistant node and that
 * node is copied into place. The result is the visible conversation ending at
 * that earlier node, with the target instruction and all later messages gone.
 */
export function recallUserMessage(
  session: Session,
  checkpointSeq: number,
): { removedText: string; event: SessionEvent } {
  const nodes = [...session.surface.nodes]
  const targetIndex = nodes.indexOf(checkpointSeq)
  if (targetIndex === -1) {
    throw new Error(`checkpoint ${checkpointSeq} is not in the current visible conversation`)
  }
  const target = session.events[checkpointSeq]
  if (target === undefined || target.type !== 'user/message' || target.data.source.kind !== 'user') {
    throw new Error(`checkpoint ${checkpointSeq} is not a real user instruction`)
  }
  const removedText = textOfUserMessage(target)

  // Find the closest preceding user/assistant node to use as the replacement anchor.
  let anchorIndex = targetIndex - 1
  while (anchorIndex >= 0) {
    const seq = nodes[anchorIndex]
    if (seq === undefined) break
    const event = session.events[seq]
    if (event?.type === 'user/message' || event?.type === 'assistant/message') break
    anchorIndex--
  }
  if (anchorIndex < 0) {
    // First message (or no earlier user/assistant anchor): replace the target
    // and everything after it with an empty assistant message. The empty
    // assistant derives to no model-visible message, so the transcript is
    // effectively cleared and the edited message can be re-sent normally.
    const endSeq = nodes[nodes.length - 1]
    if (endSeq === undefined) throw new Error('conversation has no visible messages')
    const shadowed = nodes.slice(targetIndex)
    const event = replaceRangeWithEmptyAssistant(session, checkpointSeq, endSeq, shadowed)
    return { removedText, event }
  }

  const anchorSeq = nodes[anchorIndex]
  if (anchorSeq === undefined) throw new Error('internal error: missing anchor seq')
  const endSeq = nodes[nodes.length - 1]
  if (endSeq === undefined) throw new Error('conversation has no visible messages')
  const shadowed = nodes.slice(anchorIndex)
  const anchorEvent = session.events[anchorSeq]

  let event: SessionEvent
  if (anchorEvent?.type === 'user/message') {
    event = replaceRangeWithUser(session, anchorSeq, endSeq, shadowed, anchorEvent.data.content)
  } else if (anchorEvent?.type === 'assistant/message') {
    event = replaceRangeWithAssistant(session, anchorEvent, anchorSeq, endSeq, shadowed)
  } else {
    throw new Error('internal error: anchor is neither user nor assistant message')
  }

  return { removedText, event }
}

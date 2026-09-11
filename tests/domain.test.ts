import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

import { listCheckpoints, recallUserMessage, rewindToCheckpoint } from '../src/domain.ts'
import { CheckpointSaveError, commitCheckpointRewrite } from '../src/rewrite-commit.ts'

function appendUser(session: Session, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function appendAssistant(session: Session, text: string) {
  return session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'test', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
}

test('repeating recall of the same terminal checkpoint reuses the committed event', () => {
  const session = Session.create(SessionId('recall-retry'))
  const target = appendUser(session, 'edit me')
  appendAssistant(session, 'answer')
  const first = recallUserMessage(session, target.seq)
  const seq = session.seq
  const retry = recallUserMessage(session, target.seq)
  assert.equal(retry.event, first.event)
  assert.equal(retry.removedText, 'edit me')
  assert.equal(session.seq, seq)
})

test('repeating rewind reuses the replacement, but a newer message invalidates retry', () => {
  const session = Session.create(SessionId('rewind-retry'))
  const target = appendUser(session, 'keep me')
  appendAssistant(session, 'answer')
  const first = rewindToCheckpoint(session, target.seq)
  assert.equal(rewindToCheckpoint(session, target.seq), first)
  appendUser(session, 'new work')
  const seq = session.seq
  assert.throws(() => rewindToCheckpoint(session, target.seq), /not in the current visible/)
  assert.equal(session.seq, seq)
})

test('retry cannot remove newer user messages or reuse another checkpoint recall', () => {
  const session = Session.create(SessionId('stale-recall'))
  const first = appendUser(session, 'first')
  const second = appendUser(session, 'second')
  recallUserMessage(session, first.seq)
  assert.throws(() => recallUserMessage(session, second.seq), /not in the current visible/)
  appendUser(session, 'replacement text')
  assert.throws(() => recallUserMessage(session, first.seq), /not in the current visible/)
  assert.equal(listCheckpoints(session).at(-1)?.text, 'replacement text')
})

test('failed storage preflight leaves conversation untouched', async () => {
  const session = Session.create(SessionId('preflight'))
  const target = appendUser(session, 'keep this')
  const seq = session.seq
  await assert.rejects(commitCheckpointRewrite(session, async () => { throw new Error('disk unavailable') }, () => recallUserMessage(session, target.seq)),
    error => error instanceof CheckpointSaveError && !error.committed)
  assert.equal(session.seq, seq)
  await assert.rejects(commitCheckpointRewrite(session, async () => false, () => recallUserMessage(session, target.seq)), /没有参与保存/)
  assert.equal(session.seq, seq)
})

test('failed post-commit flush can retry without appending a second replacement', async () => {
  const session = Session.create(SessionId('save-retry'))
  const target = appendUser(session, 'edit me')
  let saves = 0
  await assert.rejects(commitCheckpointRewrite(session, async () => {
    if (++saves === 2) throw new Error('disk full')
    return true
  }, () => recallUserMessage(session, target.seq)), error => error instanceof CheckpointSaveError && error.committed)
  const seq = session.seq
  const result = await commitCheckpointRewrite(session, async () => true, () => recallUserMessage(session, target.seq))
  assert.equal(result.removedText, 'edit me')
  assert.equal(session.seq, seq)
})

test('lists checkpoints through the current Session event API', () => {
  const session = Session.create(SessionId('checkpoint-list'))
  appendUser(session, 'first instruction')
  appendAssistant(session, 'answer')
  appendUser(session, 'second instruction')

  assert.deepEqual(
    listCheckpoints(session).map(({ seq, text }) => ({ seq, text })),
    [
      { seq: 0, text: 'first instruction' },
      { seq: 2, text: 'second instruction' },
    ],
  )
})

test('rewinds to a checkpoint with a valid typed surface replacement', () => {
  const session = Session.create(SessionId('checkpoint-rewind'))
  const first = appendUser(session, 'keep me')
  appendAssistant(session, 'discard me')
  appendUser(session, 'discard this too')

  rewindToCheckpoint(session, first.seq)

  assert.deepEqual(listCheckpoints(session).map(row => row.text), ['keep me'])
  assert.deepEqual(session.surface.nodes, [session.seq - 1])
})

test('recalling the first user message leaves an empty visible transcript', () => {
  const session = Session.create(SessionId('checkpoint-recall-first'))
  const first = appendUser(session, 'edit me')
  appendAssistant(session, 'old answer')

  const result = recallUserMessage(session, first.seq)

  assert.equal(result.removedText, 'edit me')
  assert.deepEqual(session.deriveMessages(), [])
})

test('recalling a later instruction preserves all earlier visible messages', () => {
  const session = Session.create(SessionId('checkpoint-recall-later'))
  appendUser(session, 'first')
  appendAssistant(session, 'anchor answer')
  const recalled = appendUser(session, 'edit second')

  const result = recallUserMessage(session, recalled.seq)

  assert.equal(result.event.type, 'system/message')
  assert.deepEqual(
    session.deriveMessages().map(message => message.role),
    ['user', 'assistant'],
  )
  assert.deepEqual(listCheckpoints(session).map(row => row.text), ['first'])
})

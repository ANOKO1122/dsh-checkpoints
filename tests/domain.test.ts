import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

import { listCheckpoints, recallUserMessage, rewindToCheckpoint } from '../src/domain.ts'

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
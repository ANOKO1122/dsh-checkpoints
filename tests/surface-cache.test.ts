import assert from 'node:assert/strict'
import test from 'node:test'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { foldSurface, Session, SessionId } from '@deepseek-ai/dsh-session'

import { createSurfaceFoldCache } from '../src/surface-cache.ts'

function appendUser(session: Session, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

test('surface fold cache recomputes only after the session sequence advances', () => {
  const session = Session.create(SessionId('surface-cache'))
  const first = appendUser(session, 'first')
  const second = appendUser(session, 'second')
  let folds = 0
  const cached = createSurfaceFoldCache((events) => {
    folds += 1
    return foldSurface(events)
  })

  assert.deepEqual(cached(session), [])
  assert.deepEqual(cached(session), [])
  assert.equal(folds, 1)

  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'summary' }],
    source: { kind: 'plugin', plugin: 'test' },
  }), {
    surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: second.seq },
    sourceEventSeqs: [first.seq, second.seq],
  })

  assert.deepEqual(cached(session), [first.seq, second.seq])
  assert.equal(folds, 2)
})

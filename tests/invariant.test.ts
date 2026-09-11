import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { apply } from '@deepseek-ai/dsh-session/invariant'
import { recallUserMessage, rewindToCheckpoint, listCheckpoints } from '../src/domain.ts'

export async function checkInvariants(session: Session) {
  let install: any
  await apply({ invariants: { register(_name: string, fn: unknown) { install = fn; return () => {} } } } as any)
  install({ sessions: { list: () => [session] }, on: () => {} }, (message: string) => { throw new Error(message) })
}

test('recall and rewind survive official invariant checks and serialized replay', async () => {
  for (const operation of [recallUserMessage, rewindToCheckpoint]) {
    const session = Session.create(SessionId('invariant-replay'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const system = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('system instructions', 'test') }, { surfaceOp: 'append' })
    const target = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'instruction' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    operation(session, target.seq)
    await checkInvariants(session)
    assert.equal(session.surface.nodes[0], system.seq)
    const reloaded = Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), session.header)
    await checkInvariants(reloaded)
    assert.deepEqual(reloaded.deriveMessages(), session.deriveMessages())
    assert.deepEqual(listCheckpoints(reloaded), listCheckpoints(session))
    const before = reloaded.seq
    operation(reloaded, target.seq)
    assert.equal(reloaded.seq, before)
  }
})

test('official invariant checker detects the previous turn-zero bug', async () => {
  const session = Session.create(SessionId('old-invalid'))
  session.append('system/message', { turn: 0, step: 0, message: createSystemMessage('', 'dsh-checkpoints') }, { surfaceOp: 'append' })
  await assert.rejects(checkInvariants(session), /open is turn null\/step null/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply as invariant } from '@deepseek-ai/dsh-session/invariant'
import { recallUserMessage, listCheckpoints } from '../src/domain.ts'
import { commitCheckpointRewrite } from '../src/rewrite-commit.ts'

// Optional monorepo integration: run with DSH_HARNESS_ROOT pointing at the
// Harness checkout. No production credentials, sessions or service are used.
for (const compression of ['none', 'zstd']) {
  test(`official ${compression} persistence saves recall and reopens with invariants`, { skip: !process.env.DSH_HARNESS_ROOT }, async t => {
    const { default: Persistence } = await import(pathToFileURL(join(process.env.DSH_HARNESS_ROOT!, 'packages/session/session-persistence-jsonl/src/index.ts')).href)
    const prefix = join(tmpdir(), 'dsh-checkpoints-persistence-')
    const root = await mkdtemp(prefix)
    const contexts: Context[] = []
    t.after(async () => {
      for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
      assert.ok(root.startsWith(prefix))
      await rm(root, { recursive: true, force: true })
    })
    const mount = async () => {
      const ctx = new Context(); contexts.push(ctx)
      await ctx.plugin(Persistence, { root, compression })
      return ctx as any
    }
    const ctx = await mount()
    const session = Session.create(SessionId(`persistence-${compression}`))
    const target = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'edit original' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const writer = await ctx.sessionPersistence.create(session.header)
    let cursor = 0
    const flush = async () => {
      const events = session.snapshotEvents().slice(cursor)
      if (events.length) { await writer.append(events); cursor += events.length }
      await writer.flush()
      return true
    }
    try { await commitCheckpointRewrite(session, flush, () => recallUserMessage(session, target.seq)) }
    finally { await writer.close() }
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    const reopened = await mount()
    const reader = await reopened.sessionPersistence.open(session.id, 'read')
    try {
      const stored = await reader.read()
      const restored = Session.create(session.id, stored.events, reader.header)
      let install: any
      await invariant({ invariants: { register(_name: string, fn: unknown) { install = fn; return () => {} } } } as any)
      install({ sessions: { list: () => [restored] }, on: () => {} }, (message: string) => { throw new Error(message) })
      assert.deepEqual(restored.deriveMessages(), session.deriveMessages())
      assert.deepEqual(listCheckpoints(restored), [])
      assert.equal(restored.eventAt(target.seq)?.type, 'user/message')
      const before = restored.seq
      recallUserMessage(restored, target.seq)
      assert.equal(restored.seq, before)
    } finally { await reader.close() }
  })
}

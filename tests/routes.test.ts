import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'
import { captureSnapshot } from '../src/file-snapshot.ts'

test('HTTP recall protects maintenance, caches retries and refuses replaying file restore after restart', async t => {
  const prefix = join(tmpdir(), 'dsh-checkpoints-http-')
  const dir = await mkdtemp(prefix)
  const cwd = join(dir, 'workspace'), root = join(dir, 'snapshots')
  await mkdir(cwd)
  const id = SessionId('http-session')
  const seed = Session.create(id)
  const session = Session.create(id, [], { ...seed.header, cwd })
  const target = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'edit' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  await writeFile(join(cwd, 'a.txt'), 'snapshot')
  await captureSnapshot(root, id, cwd, target.seq)
  await writeFile(join(cwd, 'a.txt'), 'new work')
  let maintenance = false
  const agent = { session, status: 'idle', async runMaintenance(fn: any) {
    assert.equal(maintenance, false)
    maintenance = true
    try { return await fn(new AbortController().signal) } finally { maintenance = false }
  } }
  const routes = new Map<string, any>()
  const ctx = {
    sessions: { get: () => session, flush: async () => { assert.equal(maintenance, true); return true } },
    agents: { get: () => agent, list: () => [agent] },
    get: (key: string) => key === 'webServer' ? { register: (route: any) => { routes.set(route.path, route.handler); return () => {} } } : undefined,
    effect: (fn: any) => fn(), on: () => {}, logger: { warn: () => {} },
  }
  apply(ctx as any, { snapshotRoot: root })
  const server = createServer((req, res) => { void routes.get(req.url!)(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    assert.ok(dir.startsWith(prefix)); await rm(dir, { recursive: true, force: true })
  })
  const port = (server.address() as any).port
  const post = async () => (await fetch(`http://127.0.0.1:${port}/plugins/dsh-checkpoints/recall`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: id, seq: target.seq, rollbackFiles: true }),
  })).json() as Promise<any>
  const first = await post()
  assert.equal(first.ok, true)
  assert.equal(first.value.filesRestored, true)
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'snapshot')
  assert.equal(await readFile(join(first.value.fileBackup, 'files/a.txt'), 'utf8'), 'new work')
  const seq = session.seq
  await writeFile(join(cwd, 'a.txt'), 'after first rollback')
  assert.deepEqual(await post(), first)
  assert.equal(session.seq, seq)
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'after first rollback')
  apply(ctx as any, { snapshotRoot: root }) // New plugin instance has no receipt cache.
  const retry = await post()
  assert.equal(retry.ok, true)
  assert.equal(retry.value.filesRestored, false)
  assert.match(retry.value.fileError, /未再次恢复文件/)
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'after first rollback')
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'new prompt' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  assert.equal((await post()).ok, false)
  assert.equal(maintenance, false)
})

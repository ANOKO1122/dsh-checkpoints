import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { captureSnapshot, restoreSnapshot } from '../src/file-snapshot.ts'
import { backupRestoreTargets, safeRestorePath } from '../src/restore-backup.ts'

const exec = promisify(execFile)
async function fixture(t: any) {
  const prefix = join(tmpdir(), 'dsh-checkpoints-test-')
  const dir = await mkdtemp(prefix)
  t.after(async () => { assert.ok(dir.startsWith(prefix)); await rm(dir, { recursive: true, force: true }) })
  const cwd = join(dir, 'workspace'), root = join(dir, 'snapshots')
  await mkdir(cwd)
  return { dir, cwd, root }
}

test('copy restore backs up current bytes and preserves newly created files by default', async t => {
  const { cwd, root } = await fixture(t)
  await writeFile(join(cwd, 'a.txt'), 'checkpoint')
  await captureSnapshot(root, 'session', cwd, 1, true)
  await writeFile(join(cwd, 'a.txt'), 'valuable edit')
  await writeFile(join(cwd, 'new.txt'), 'keep')
  const { backupPath } = await restoreSnapshot(root, 'session', cwd, 1)
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'checkpoint')
  assert.equal(await readFile(join(cwd, 'new.txt'), 'utf8'), 'keep')
  assert.equal(await readFile(join(backupPath, 'files/a.txt'), 'utf8'), 'valuable edit')
  assert.equal(JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8')).status, 'completed')
})

test('backup preflight failure and missing snapshots leave workspace untouched', async t => {
  const { cwd, root } = await fixture(t)
  await writeFile(join(cwd, 'a.txt'), 'old')
  await writeFile(join(cwd, 'b.txt'), 'old b')
  await captureSnapshot(root, 'session', cwd, 1)
  await writeFile(join(cwd, 'a.txt'), 'new')
  await rm(join(cwd, 'b.txt'))
  await mkdir(join(cwd, 'b.txt'))
  await assert.rejects(restoreSnapshot(root, 'session', cwd, 1), /不是普通文件/)
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'new')
  await assert.rejects(restoreSnapshot(root, 'session', cwd, 999), /no file snapshot/)
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'new')
})

test('backup manifest records absent files and rejects path traversal and junctions', async t => {
  const { dir, cwd } = await fixture(t)
  const backup = join(dir, 'backup')
  const finish = await backupRestoreTargets(cwd, ['absent.txt'], backup)
  await finish('partial', 'test failure')
  const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.files, [{ path: 'absent.txt', existed: false }])
  for (const path of ['../outside', 'a/../outside', 'C:/outside', 'a:stream', '.git/config', '.dsh/settings', '.git /config', '.git/../x']) {
    await assert.rejects(safeRestorePath(cwd, path), /不安全|超出/)
  }
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await symlink(outside, join(cwd, 'link'), 'junction')
  await assert.rejects(safeRestorePath(cwd, 'link/file.txt'), /符号链接|目录联接/)
})

test('git hybrid restores tracked and untracked files with recoverable backups', async t => {
  const { cwd, root } = await fixture(t)
  const git = (...args: string[]) => exec('git', ['-C', cwd, ...args], { windowsHide: true })
  await git('init')
  await writeFile(join(cwd, 'tracked.txt'), 'baseline')
  await git('add', 'tracked.txt')
  await git('-c', 'user.name=Checkpoint Test', '-c', 'user.email=checkpoint@example.invalid', 'commit', '-m', 'fixture')
  await writeFile(join(cwd, 'untracked.txt'), 'snapshot')
  await captureSnapshot(root, 'session', cwd, 1)
  await writeFile(join(cwd, 'tracked.txt'), 'new tracked')
  await writeFile(join(cwd, 'untracked.txt'), 'new untracked')
  const { backupPath } = await restoreSnapshot(root, 'session', cwd, 1)
  assert.equal(await readFile(join(cwd, 'tracked.txt'), 'utf8'), 'baseline')
  assert.equal(await readFile(join(cwd, 'untracked.txt'), 'utf8'), 'snapshot')
  assert.equal(await readFile(join(backupPath, 'files/tracked.txt'), 'utf8'), 'new tracked')
  assert.equal(await readFile(join(backupPath, 'files/untracked.txt'), 'utf8'), 'new untracked')
})

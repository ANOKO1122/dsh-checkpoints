import { copyFile, lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Reject traversal, Windows streams, and symlink/junction destinations. */
export async function safeRestorePath(root: string, relative: string): Promise<string> {
  const parts = relative.split(/[\\/]/)
  if (isAbsolute(relative) || parts.some(part => !part || part === '.' || part === '..'
    || part.includes(':') || /[ .]$/.test(part) || part.toLowerCase() === '.git' || part.toLowerCase() === '.dsh')) {
    throw new Error(`不安全的恢复路径：${relative}`)
  }
  const base = resolve(root)
  const target = resolve(base, ...parts)
  if (!target.startsWith(base + sep)) throw new Error(`恢复路径超出工作目录：${relative}`)
  let cursor = base
  for (const part of parts) {
    cursor = join(cursor, part)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`拒绝通过符号链接或目录联接恢复：${relative}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return target
}

/** Snapshot enumeration must fail closed, not treat unreadable folders as empty. */
export async function listRestoreFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`快照含有不支持的链接：${path}`)
      if (entry.isDirectory()) await walk(join(dir, entry.name), path)
      else if (entry.isFile()) files.push(path)
      else throw new Error(`快照含有不支持的文件：${path}`)
    }
  }
  await walk(root, '')
  return files
}

/** All affected bytes are copied before any workspace file is overwritten. */
export async function backupRestoreTargets(cwd: string, paths: readonly string[], backupPath: string) {
  const files: { path: string; existed: boolean }[] = []
  for (const path of [...new Set(paths)].sort()) {
    const source = await safeRestorePath(cwd, path)
    let existed = false
    try {
      const info = await lstat(source)
      if (!info.isFile()) throw new Error(`恢复目标不是普通文件：${path}`)
      existed = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existed) {
      const target = join(backupPath, 'files', path)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
    }
    files.push({ path, existed })
  }
  const manifest = { cwd: resolve(cwd), time: Date.now(), files }
  await mkdir(backupPath, { recursive: true })
  await writeFile(join(backupPath, 'manifest.json'), JSON.stringify({ ...manifest, status: 'ready' }, null, 2))
  return async (status: 'completed' | 'partial', error?: string): Promise<void> => {
    await writeFile(join(backupPath, 'manifest.json'), JSON.stringify({ ...manifest, status, error }, null, 2))
  }
}

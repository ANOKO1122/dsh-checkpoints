/**
 * Shared path helper for the file-change rows (RoundChangesCard, FileStatsBar):
 * rows render the basename big and the directory small, so both need the same
 * name/dir split. Accepts both `/` and `\` separators.
 */
export function splitPath(path: string): { name: string; dir: string } {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0)
  const name = segments[segments.length - 1] ?? path
  return { name, dir: segments.slice(0, -1).join('/') }
}

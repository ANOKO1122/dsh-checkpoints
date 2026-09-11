import type { Session } from '@deepseek-ai/dsh-session'

export class CheckpointSaveError extends Error {
  constructor(readonly committed: boolean, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(committed
      ? '对话回退已在内存中生效，但保存失败。请勿重启；重试会继续保存，不会再次回退。原因：' + detail
      : '会话保存检查失败，未执行新的回退。原因：' + detail)
    this.name = 'CheckpointSaveError'
  }
}

/** Check storage first, then distinguish committed mutations from save failures. */
export async function commitCheckpointRewrite<T>(
  session: Session,
  flush: (session: Session) => Promise<boolean>,
  rewrite: () => T,
): Promise<T> {
  const revision = session.seq
  const save = async (committed: boolean): Promise<void> => {
    try {
      if (!await flush(session)) throw new Error('没有参与保存的会话持久化监听器')
    } catch (cause) { throw new CheckpointSaveError(committed, cause) }
  }
  await save(false)
  if (session.seq !== revision) throw new Error('会话已更新，请刷新检查点后重试；未执行回退。')
  const result = rewrite()
  await save(true)
  return result
}

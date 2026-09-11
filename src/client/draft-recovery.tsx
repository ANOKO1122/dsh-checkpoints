import { useEffect, useState } from 'react'
import css from './round-changes-card.module.css'

export const DRAFT_CHANGED = 'dsh-checkpoints:draft-changed'
export function announceDraftChange(): void { window.dispatchEvent(new Event(DRAFT_CHANGED)) }

/** Only text is stored in this tab; image bytes remain owned by the editor. */
export function DraftRecovery({ sessionId, isEditing, restore }: {
  sessionId: string
  isEditing: () => boolean
  restore: (text: string) => void
}) {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const update = () => setRevision(value => value + 1)
    window.addEventListener(DRAFT_CHANGED, update)
    return () => window.removeEventListener(DRAFT_CHANGED, update)
  }, [])
  const prefix = `dsh-checkpoints:edit:${sessionId}:`
  const drafts: { key: string; seq: number; text: string }[] = []
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (key?.startsWith(prefix)) drafts.push({ key, seq: Number(key.slice(prefix.length)), text: sessionStorage.getItem(key) ?? '' })
    }
  } catch { return null }
  void revision
  const draft = drafts.sort((a, b) => b.seq - a.seq)[0]
  if (!draft || isEditing()) return null
  return <div className={css.card}>
    <div className={css.head}>
      <span className={css.summary}>检查点 #{draft.seq} 有暂存文字草稿</span>
      <button className={css.button} type="button" onClick={() => {
        if (window.confirm('将暂存文字恢复到输入框？这会替换输入框现有文字，不会自动发送。图片未保存在文字草稿中，请重新核对或添加。')) restore(draft.text)
      }}>恢复文字</button>
      <button className={css.button} type="button" onClick={() => {
        try { sessionStorage.removeItem(draft.key); announceDraftChange() } catch { /* storage unavailable */ }
      }}>丢弃草稿</button>
    </div>
  </div>
}

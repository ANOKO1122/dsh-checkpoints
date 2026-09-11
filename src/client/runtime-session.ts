import type { ChatSnapshot, SessionBinding, SessionsFace, SessionFace } from './context-types.ts'

interface ChatTarget {
  getSnapshot(): ChatSnapshot | undefined
  subscribe(listener: () => void): () => void
}

/** Adapt the public session and independently published conversation view. */
export function adaptSessions(sessions: SessionsFace, targetFor: (binding: SessionBinding) => ChatTarget | undefined): SessionsFace {
  const cache = new WeakMap<SessionBinding, SessionBinding>()
  return {
    list: sessions.list,
    scope: id => sessions.scope(id),
    open: id => sessions.open(id),
    binding(id) {
      const binding = sessions.binding(id)
      if (!binding) return undefined
      const cached = cache.get(binding)
      if (cached) return cached
      const original = binding.session
      const target = targetFor(binding)
      const session: SessionFace = {
        sessionId: original.sessionId,
        get snapshotCache() {
          const snapshot = original.getSnapshot?.() ?? original.snapshotCache
          return { ...snapshot, chat: target?.getSnapshot() ?? snapshot?.chat }
        },
        subscribe(listener) {
          const offSession = original.subscribe(listener)
          const offChat = target?.subscribe(listener)
          return () => { offSession(); offChat?.() }
        },
        ...(original.loadOlder ? { loadOlder: () => original.loadOlder!() } : {}),
        ...(original.loadThrough ? { loadThrough: (seq: number) => original.loadThrough!(seq) } : {}),
        ...(original.readAttachment ? { readAttachment: (id: string) => original.readAttachment!(id) } : {}),
      }
      const adapted = { ...binding, session }
      cache.set(binding, adapted)
      return adapted
    },
  }
}

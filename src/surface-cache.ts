import { foldSurface, type Session, type SessionEvent, type SurfaceFoldResult } from '@deepseek-ai/dsh-session'

type SurfaceFolder = (events: readonly SessionEvent[]) => SurfaceFoldResult

/**
 * Cache shadowed surface sequence ids by Session identity and append sequence.
 * Session logs are append-only, so the cached fold remains valid until seq moves.
 */
export function createSurfaceFoldCache(
  fold: SurfaceFolder = foldSurface,
): (session: Session) => readonly number[] {
  const cache = new WeakMap<Session, { seq: number; shadowedSeqs: readonly number[] }>()

  return (session) => {
    const cached = cache.get(session)
    if (cached?.seq === session.seq) return cached.shadowedSeqs

    const folded = fold(session.snapshotEvents())
    const shadowedSeqs = [
      ...new Set(folded.replacements.flatMap(replacement => replacement.shadowedSeqs)),
    ]
    cache.set(session, { seq: session.seq, shadowedSeqs })
    return shadowedSeqs
  }
}

export const shadowedSeqsForSession = createSurfaceFoldCache()

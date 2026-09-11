/** In-process FIFO lock; failures never poison queued operations. */
export function createOperationLock() {
  const tails = new Map<string, Promise<void>>()
  return async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    tails.set(key, tail)
    await previous
    try { return await operation() }
    finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }
}

export interface MaintenanceOwner {
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/** Claims every affected live agent before the first asynchronous mutation. */
export function withMaintenance<T>(owners: readonly MaintenanceOwner[], task: () => Promise<T>): Promise<T> {
  const enter = (index: number): Promise<T> => {
    const owner = owners[index]
    return owner === undefined ? task() : owner.runMaintenance(signal => {
      signal.throwIfAborted()
      return enter(index + 1)
    })
  }
  return enter(0)
}

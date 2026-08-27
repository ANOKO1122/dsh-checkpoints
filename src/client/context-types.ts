/**
 * Structural client-side types for the services this plugin consumes.
 *
 * A third-party DSH plugin resolves outside the monorepo's single cordis
 * instance, so upstream `declare module` augmentations do not always reach
 * this Context. These mirrors are intentionally read-only/minimal.
 */

import type { Context as CordisContext } from '@deepseek-ai/cordis'

/** One checkpoint row served by the host. */
export interface Checkpoint {
  readonly seq: number
  readonly time: number
  readonly text: string
  readonly hasSnapshot?: boolean
}

/** One file line-diff statistic served by the host. */
export interface FileDiffStat {
  readonly path: string
  readonly additions: number
  readonly deletions: number
  /** True when the file is binary; the counts are meaningless for it. */
  readonly binary?: boolean
}

/** The session list feed (active session tracking). */
export interface SessionListState {
  readonly current?: string
  readonly byId: Record<string, unknown>
}

export interface SessionListFeed {
  getSnapshot(): SessionListState
  subscribe(callback: () => void): () => void
}

/** One chat node (a row in the conversation flow). */
export interface ChatNode {
  readonly key: string
  readonly kind: string
  /** Stable sortable render position; for user messages this equals the event seq. */
  readonly anchorSeq: number
  readonly data?: {
    readonly content?: unknown
    readonly time?: number
  }
}

/** The assembled chat view snapshot (subset). */
export interface ChatSnapshot {
  readonly order: readonly string[]
  readonly nodes: ReadonlyMap<string, ChatNode>
  readonly locations?: {
    readonly turns?: ReadonlyMap<number, readonly string[]>
  }
}

/** The full session snapshot (subset). */
export interface ConversationSnapshot {
  readonly sessionId: string
  readonly chat?: ChatSnapshot
  readonly running?: boolean
}

/** Loose RPC result mirror (every runtime call answers one of these). */
export interface RpcResultLike<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code?: string; readonly message?: string }
}

/** One durable image reference inside a sent message's content blocks. */
export interface MessageImageRef {
  readonly attachmentId: string
  readonly mediaType?: string
}

/** The runtime Session face this plugin reads. */
export interface SessionFace {
  readonly sessionId: string
  subscribe(listener: () => void): () => void
  snapshotCache: ConversationSnapshot
  /** Load the next page of older history, when the runtime exposes it. */
  loadOlder?(): Promise<void>
  /**
   * Read one durable image attachment referenced by a sent message
   * (historical message images); absent on older runtimes.
   */
  readAttachment?(attachmentId: string): Promise<RpcResultLike<{
    attachment: { readonly mediaType?: string }
    data: Uint8Array
  }>>
}

export interface SessionBinding {
  readonly sessionId: string
  readonly session: SessionFace
}

/** The client `sessions` service face. */
export interface SessionsFace {
  list: SessionListFeed
  binding(id: string): SessionBinding | undefined
  scope(id: string): unknown
  open(id: string): void
}

/** The composer input face from ui-conversation. */
export interface InputFace {
  setDraft(text: string): void
  submit(): void
  /** Append browser-owned draft image ids to the composer rail (absent on older runtimes). */
  addImages?(ids: readonly string[]): boolean
}

/** The conversation service face exposing the input resolver. */
export interface ConversationFace {
  input: {
    for(actx: unknown): InputFace
  }
  /** Register browser files as composer draft images; absent on older runtimes. */
  createDraftImages?(files: readonly File[]): readonly { readonly id: string }[]
}

/** Host-advisory complete provider/model/reasoning selection. */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One selectable model in a provider group. */
export interface ModelInfo {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: {
    readonly defaultEffort?: string
    readonly efforts?: readonly { readonly id: string; readonly name?: string; readonly description?: string }[]
  }
}

/** One provider group in the model directory. */
export interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelInfo[]
}

/** Live state of one session's model directory (ui-model-selection). */
export interface ModelDirectoryState {
  readonly current: ModelSelection | null
  readonly groups: readonly ModelProviderGroup[]
  readonly status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  readonly error: string | null
}

/** Snapshot store face (uSES-compatible). */
export interface ModelDirectoryStore {
  getSnapshot(): ModelDirectoryState
  subscribe(callback: () => void): () => void
}

/** One session's shared model directory controller. */
export interface ModelDirectoryFace {
  readonly store: ModelDirectoryStore
  load(): Promise<unknown>
  select(selection: ModelSelection): Promise<void>
}

/** The `ctx.modelDirectories` service face. */
export interface ModelDirectoriesFace {
  directoryFor(sessionId: string): ModelDirectoryFace
}

/** Minimal slot-registry face used for sidebar + composer-dock integration. */
export interface SlotsFace {
  register(options: {
    name: string
    id?: string
    order?: number
    priority?: number
    label?: string | (() => string)
  }, component: unknown): () => void
  /**
   * Register into a slot once its declaration exists: the callback runs
   * immediately when the slot is already declared, otherwise it re-runs on
   * declaration. Handles plugin-vs-owner load order without polling.
   */
  inject(key: string, callback: () => () => void): () => void
}

/** Context augmentation for the services this plugin injects. */
export interface Context extends CordisContext {
  sessions: SessionsFace
  conversation?: ConversationFace
  slots?: SlotsFace
  /** Optional ui-model-selection service (absent when that plugin is disabled). */
  modelDirectories?: ModelDirectoriesFace
}

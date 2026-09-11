/**
 * Browser half of dsh-checkpoints.
 *
 * Registers a sidebar-footer toggle and a docked right-hand "检查点 · 文件改动"
 * sidebar, inserts an inline edit icon next to the built-in copy icon under
 * every rendered user message, and keeps message-action DOM in sync. Clicking
 * the edit icon hides the original row and mounts an inline editor in its
 * place with a composer-style send button and model selector.
 *
 * Two more surfaces are registered as slots:
 *   - RoundChangesCard via the `conversation.input.dock` slot (order 5):
 *     the "本轮改动" strip between the shipped todo strip and the input
 *     card, sharing the dock column's width/scroll constraints.
 *   - DiffViewerOverlay: the file comparison dialog (unified/side-by-side),
 *     registered as its own `shell.overlay` slot entry.
 */

import { createElement, Fragment, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context, ConversationFace, ModelDirectoryFace, ModelDirectoriesFace, SessionListState } from './context-types.ts'
import { DiffViewerOverlay } from './diff-viewer.tsx'
import type { InlineEditImage } from './inline-edit.tsx'
import { InlineEdit } from './inline-edit.tsx'
import { loadRequiredImages } from './required-images.ts'
import { createLatestRequest } from './latest-request.ts'
import { DraftRecovery, announceDraftChange } from './draft-recovery.tsx'
import { adaptSessions } from './runtime-session.ts'
import { reconcileMessageActions, type MessageImageRef } from './message-actions.ts'
import { RoundChangesCard } from './round-changes-card.tsx'
import { CheckpointSidebarOverlay, createPanelStore, type RootSlotRuntimeProps } from './sidebar.tsx'

/** Services required before mounting. */
export const inject = ['sessions', 'slots', 'uiConversation']

/** Minimum delay between DOM-recovery attach attempts. */
const ATTACH_COOLDOWN_MS = 300

const RECALL_URL = '/plugins/dsh-checkpoints/recall'
const SURFACE_URL = '/plugins/dsh-checkpoints/surface'

interface ApiEnvelope<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code?: string; readonly message?: string }
}

interface RecallResult {
  readonly seq: number
  readonly removedText: string
  /** False when the server failed to roll files back after the rewrite. */
  readonly filesRestored?: boolean
  readonly fileError?: string
}

async function postRecall(
  sessionId: string,
  seq: number,
  extra?: { readonly rollbackFiles?: boolean; readonly deleteNewFiles?: boolean },
): Promise<RecallResult> {
  const response = await fetch(RECALL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sessionId, seq, ...extra }),
  })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`bad response from server (HTTP ${response.status})`)
  }
  const envelope = body as ApiEnvelope<RecallResult>
  if (!envelope.ok || envelope.value === undefined) {
    throw new Error(envelope.error?.message ?? 'recall failed')
  }
  return envelope.value
}

async function fetchShadowedSeqs(sessionId: string): Promise<Set<number>> {
  const response = await fetch(`${SURFACE_URL}?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: { accept: 'application/json' },
  })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`bad response from server (HTTP ${response.status})`)
  }
  const envelope = body as ApiEnvelope<{ shadowedSeqs: number[] }>
  if (!envelope.ok || envelope.value === undefined) {
    throw new Error(envelope.error?.message ?? 'surface fold failed')
  }
  return new Set(envelope.value.shadowedSeqs)
}

export function apply(ctx: Context): void {
  const uiConversation = ctx.get('uiConversation') as { binding(binding: unknown): { target(name: string): { getSnapshot(): import('./context-types.ts').ChatSnapshot | undefined; subscribe(listener: () => void): () => void } } } | undefined
  const sessions = adaptSessions(ctx.sessions, binding => uiConversation?.binding(binding).target('chat'))

  const slots = ctx.slots
  const panelStore = createPanelStore()

  let scrollport: HTMLElement | null = null
  let boundSessionId: string | undefined
  let offBoundSession: (() => void) | undefined
  let lastAttachAttempt = 0
  let hiddenKeys: Set<string> | null = null
  let shadowedSeqs: Set<number> | null = null
  let reconcileTimer: number | undefined
  const slotDisposers: (() => void)[] = []

  // Inline edit state (only one editor is ever open at a time).
  let editRoot: Root | null = null
  let editHost: HTMLDivElement | null = null
  let editRow: HTMLElement | null = null
  let editingKey: string | null = null
  /** Open-generation token: stale async image loads must not mount over a newer editor. */
  let editOpenSeq = 0
  const surfaceRequests = createLatestRequest()

  const collectHiddenKeys = (seq: number, inclusive: boolean): Set<string> => {
    const keys = new Set<string>()
    if (boundSessionId === undefined) return keys
    const binding = sessions.binding(boundSessionId)
    if (binding === undefined) return keys
    const chat = binding.session.snapshotCache.chat
    if (!chat) return keys
    for (const node of chat.nodes.values()) {
      if (inclusive ? node.anchorSeq >= seq : node.anchorSeq > seq) keys.add(node.key)
    }
    return keys
  }

  /** Resolve the shared model directory for a session, when available. */
  const modelDirectoryFor = (sessionId: string): ModelDirectoryFace | null => {
    try {
      const directories = ctx.get('modelDirectories') as ModelDirectoriesFace | undefined
      return directories?.directoryFor(sessionId) ?? null
    } catch (cause) {
      console.warn('[dsh-checkpoints] model directory unavailable:', cause)
      return null
    }
  }

  const closeInlineEditor = (restoreRow: boolean): void => {
    editOpenSeq++
    if (editRoot !== null) {
      editRoot.unmount()
      editRoot = null
    }
    editHost?.remove()
    editHost = null
    if (editRow !== null && restoreRow) editRow.style.display = ''
    editRow = null
    editingKey = null
    announceDraftChange()
  }

  const teardown = (reason: string): void => {
    surfaceRequests.invalidate()
    console.warn(`[dsh-checkpoints] teardown: ${reason}`)
    if (reconcileTimer !== undefined) window.clearTimeout(reconcileTimer)
    reconcileTimer = undefined
    closeInlineEditor(false)
    offBoundSession?.()
    offBoundSession = undefined
    scrollport = null
    boundSessionId = undefined
    hiddenKeys = null
    shadowedSeqs = null
  }


  /**
   * Fetch a sent message's images back as browser files so the inline editor
   * can show them (and re-send them) like pre-send composer drafts.
   * A missing image stops the editor opening; no silent text-only fallback.
   */
  const loadEditImages = async (sessionId: string, imageRefs: readonly MessageImageRef[]): Promise<InlineEditImage[]> => {
    if (imageRefs.length === 0) return []
    const binding = sessions.binding(sessionId)
    if (binding === undefined || binding.session.readAttachment === undefined) throw new Error('当前会话不支持读取原图片，已停止编辑，对话未回退。')
    return loadRequiredImages(imageRefs, async (ref): Promise<InlineEditImage> => {
        const result = await binding.session.readAttachment!(ref.attachmentId)
        if (!result.ok || result.value === undefined) throw new Error('图片读取失败')
        const mediaType = ref.mediaType ?? result.value.attachment.mediaType ?? 'image/png'
        const extension = mediaType.split('/')[1] ?? 'png'
        // Copy into a plain-ArrayBuffer view: the wire bytes may be typed
        // ArrayBufferLike, which File/Blob parts reject under strict lib types.
        const bytes = new Uint8Array(result.value.data)
        const file = new File([bytes], `image.${extension}`, { type: mediaType })
        return { file, previewUrl: URL.createObjectURL(file) }
    }, image => URL.revokeObjectURL(image.previewUrl))
  }

  const openInlineEditor = (sessionId: string, seq: number, text: string, imageRefs: readonly MessageImageRef[], row: HTMLElement, key: string): void => {
    closeInlineEditor(true)

    const openSeq = ++editOpenSeq
    const draftKey = `dsh-checkpoints:edit:${sessionId}:${seq}`
    let recalled: RecallResult | undefined
    let sendUncertain = false
    editingKey = key
    editRow = row
    row.style.display = 'none'

    editHost = document.createElement('div')
    editHost.dataset.dshCheckpointsInlineEdit = ''
    row.after(editHost)

    const mount = (images: readonly InlineEditImage[]): void => {
      editRoot = createRoot(editHost!)
      editRoot.render(createElement(InlineEdit, {
        sessionId,
        initialText: text,
        draftKey,
        initialImages: images,
        modelDirectory: modelDirectoryFor(sessionId),
        onSubmit: async (editedText, _selection, files, rollbackFiles) => {
          if (sendUncertain) throw new Error('上次发送的结果尚不确定，请先核对会话，避免重复发送。文字和图片仍保留在编辑器。')
          const conversation = ctx.get('conversation') as ConversationFace | undefined
          const rawBinding = ctx.sessions.binding(sessionId)
          if (!conversation?.sendSession || !rawBinding) throw new Error('当前 Harness 缺少有回执的发送接口，未执行新的回退。')
          const drafts = files.length ? (conversation.createDrafts?.(sessionId, files) ?? conversation.createDraftImages?.(files) ?? []) : []
          if (drafts.length !== files.length) {
            conversation.releaseDraftAttachments?.(drafts)
            throw new Error('图片准备不完整，未执行新的回退。请重试。')
          }
          try {
            if (openSeq !== editOpenSeq) throw new Error('编辑已关闭，未执行新的回退。')
            recalled ??= await postRecall(sessionId, seq, { rollbackFiles, deleteNewFiles: false })
            if (boundSessionId === sessionId) {
              hiddenKeys = collectHiddenKeys(seq, true)
              refreshShadowedSeqs(sessionId)
            }
            if (recalled.filesRestored === false) {
              throw new Error(`对话已回退，但文件恢复失败，已停止自动发送。${recalled.fileError ?? '文件可能部分恢复。'} 文字和图片保留在编辑器；请先处理文件状态。`)
            }
            if (openSeq !== editOpenSeq) throw new Error('对话已回退，编辑已关闭，未发送新消息。')
            sendUncertain = true
            const outcome = await conversation.sendSession(rawBinding.session, editedText, drafts.map(item => item.id), 'queue')
            sendUncertain = false
            if (outcome.kind !== 'success') throw new Error(outcome.text ?? '发送被拒绝，编辑内容已保留，可重试；不会重复回退文件。')
            try { sessionStorage.removeItem(draftKey); announceDraftChange() } catch { /* best effort */ }
            if (openSeq === editOpenSeq) closeInlineEditor(false)
            scheduleReconcile()
          } catch (cause) {
            if (!sendUncertain) conversation.releaseDraftAttachments?.(drafts)
            throw cause
          }
        },
        /* Legacy composer submission intentionally removed: submit() is void,
         * so it cannot confirm Host admission or safely dispose the editor. */
        onCancel: () => {
          closeInlineEditor(true)
          scheduleReconcile()
        },
      }))
    }

    const load = (): void => {
      void loadEditImages(sessionId, imageRefs).then((images) => {
        if (openSeq !== editOpenSeq || editHost === null) {
          for (const image of images) URL.revokeObjectURL(image.previewUrl)
          return
        }
        editRoot?.unmount()
        mount(images)
      }).catch(cause => {
        if (openSeq !== editOpenSeq || editHost === null) return
        editRoot ??= createRoot(editHost)
        editRoot.render(createElement('div', { role: 'alert' },
          createElement('p', null, cause instanceof Error ? cause.message : String(cause)),
          createElement('button', { type: 'button', onClick: load }, '重试加载图片'),
          createElement('button', { type: 'button', onClick: () => closeInlineEditor(true) }, '取消编辑')))
      })
    }
    load()
  }

  function scheduleReconcile(): void {
    if (reconcileTimer !== undefined) window.clearTimeout(reconcileTimer)
    reconcileTimer = window.setTimeout(() => {
      reconcileTimer = undefined
      if (scrollport === null || boundSessionId === undefined || scrollport.isConnected !== true) return
      const sessionId = boundSessionId
      const binding = sessions.binding(sessionId)
      if (binding === undefined) return
      reconcileMessageActions(binding.session, scrollport, hiddenKeys, shadowedSeqs, editingKey, {
        onEdit: (seq, text, images, row, key) => {
          openInlineEditor(sessionId, seq, text, images, row, key)
        },
      })
    }, 60)
  }

  function refreshShadowedSeqs(sessionId: string): void {
    const isLatest = surfaceRequests.begin()
    void fetchShadowedSeqs(sessionId).then((seqs) => {
      if (!isLatest() || boundSessionId !== sessionId) return
      shadowedSeqs = seqs
      scheduleReconcile()
    }).catch((cause: unknown) => {
      console.warn('[dsh-checkpoints] surface fold fetch failed:', cause)
    })
  }

  const attach = (sessionId: string): boolean => {
    if (scrollport?.isConnected && boundSessionId === sessionId) return true
    teardown(`re-attach for session "${sessionId}"`)
    const sp = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (!sp) {
      console.warn('[dsh-checkpoints] attach skipped: no [data-conversation-scroll] yet')
      return false
    }
    const binding = sessions.binding(sessionId)
    if (binding === undefined) {
      console.warn(`[dsh-checkpoints] attach skipped: no session binding for "${sessionId}"`)
      return false
    }
    scrollport = sp
    boundSessionId = sessionId
    offBoundSession = binding.session.subscribe(scheduleReconcile)
    scheduleReconcile()
    refreshShadowedSeqs(sessionId)
    console.log(`[dsh-checkpoints] attached to session "${sessionId}"`)
    return true
  }

  // Composer dock entry: the "本轮改动" strip between the shipped todo strip
  // (order 0) and the input card. The dock renders per session scope, so the
  // card remounts with its session; `slots.inject` waits for ui-conversation
  // to declare the slot when this plugin loads first.
  const RoundChangesDock = (props: { session?: { readonly sessionId: string } }): ReactNode => {
    const sessionId = props.session?.sessionId
    if (sessionId === undefined) return null
    const binding = sessions.binding(sessionId)
    if (binding === undefined) return null
    return createElement(Fragment, null,
      createElement(RoundChangesCard, { sessionId, session: binding.session }),
      createElement(DraftRecovery, { sessionId, isEditing: () => boundSessionId === sessionId && editingKey !== null,
        restore: text => {
          const scope = sessions.scope(sessionId)
          const conversation = ctx.get('conversation') as ConversationFace | undefined
          if (scope && conversation) conversation.input.for(scope).setDraft(text)
          else window.alert('当前输入框不可用，草稿仍保留，请重新打开会话后重试。')
        },
      }))
  }

  // Sidebar toggle in the left nav footer + the docked right-hand panel.
  if (slots !== undefined) {
    const OverlayEntry = (props: { useSessions?: (selector: (state: SessionListState) => unknown) => unknown }): ReactNode => (
      createElement(CheckpointSidebarOverlay, {
        panelStore,
        sessions,
        useSessions: props.useSessions as RootSlotRuntimeProps['useSessions'],
      })
    )
    slotDisposers.push(slots.register({ name: 'shell.overlay', id: 'dsh-checkpoints-sidebar', order: 0 }, OverlayEntry))

    const DiffViewerEntry = (): ReactNode => createElement(DiffViewerOverlay)
    slotDisposers.push(slots.register({ name: 'shell.overlay', id: 'dsh-checkpoints-diff-viewer', order: 1 }, DiffViewerEntry))

    slotDisposers.push(slots.inject('conversation.input.dock', () =>
      slots.register({
        name: 'conversation.input.dock',
        id: 'dsh-checkpoints-round-changes',
        order: 5,
      }, RoundChangesDock),
    ))
  }

  const sync = (): void => {
    const current = sessions.list.getSnapshot().current
    if (current === undefined) return
    const now = Date.now()
    if (now - lastAttachAttempt < ATTACH_COOLDOWN_MS) return
    lastAttachAttempt = now
    attach(current)
  }

  const offList = sessions.list.subscribe(sync)

  const mo = new MutationObserver((mutations) => {
    if (scrollport !== null && !scrollport.isConnected) {
      teardown('conversation surface detached')
      sync()
      return
    }
    if (scrollport === null) {
      sync()
      return
    }
    // Only conversation-surface mutations need a reconcile; typing elsewhere
    // (composer, sidebars, overlays) no longer schedules a full row scan.
    for (const mutation of mutations) {
      const target = mutation.target
      if (target instanceof Node && (target === scrollport || scrollport.contains(target))) {
        scheduleReconcile()
        return
      }
    }
  })
  mo.observe(document.body, { childList: true, subtree: true })

  sync()

  ctx.effect(() => () => {
    teardown('fiber dispose')
    offList()
    mo.disconnect()
    for (const dispose of slotDisposers) dispose()
    slotDisposers.length = 0
  }, 'dsh-checkpoints: panel lifecycle')
}

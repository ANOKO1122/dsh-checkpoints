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

import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context, ConversationFace, ModelDirectoryFace, ModelDirectoriesFace, SessionListState } from './context-types.ts'
import { DiffViewerOverlay } from './diff-viewer.tsx'
import type { InlineEditImage } from './inline-edit.tsx'
import { InlineEdit } from './inline-edit.tsx'
import { reconcileMessageActions, type MessageImageRef } from './message-actions.ts'
import { RoundChangesCard } from './round-changes-card.tsx'
import { CheckpointSidebarOverlay, createPanelStore, type RootSlotRuntimeProps } from './sidebar.tsx'

/** Services required before mounting. */
export const inject = ['sessions', 'slots']

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
  const sessions = ctx.sessions

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
    if (editRoot !== null) {
      editRoot.unmount()
      editRoot = null
    }
    editHost?.remove()
    editHost = null
    if (editRow !== null && restoreRow) editRow.style.display = ''
    editRow = null
    editingKey = null
  }

  const teardown = (reason: string): void => {
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

  /** Set the composer draft for a session; false when the service is absent. */
  const setDraftFor = (sessionId: string, text: string): boolean => {
    try {
      const scope = sessions.scope(sessionId)
      const conversation = ctx.get('conversation') as { input: { for(actx: unknown): { setDraft(text: string): void } } } | undefined
      if (scope !== undefined && conversation !== undefined) {
        conversation.input.for(scope).setDraft(text)
        return true
      }
      return false
    } catch (error) {
      console.warn('[dsh-checkpoints] failed to set composer draft:', error)
      return false
    }
  }

  /** Submit the composer draft for a session; false when the service is absent. */
  const submitFor = (sessionId: string): boolean => {
    try {
      const scope = sessions.scope(sessionId)
      const conversation = ctx.get('conversation') as { input: { for(actx: unknown): { submit(): void } } } | undefined
      if (scope !== undefined && conversation !== undefined) {
        conversation.input.for(scope).submit()
        return true
      }
      return false
    } catch (error) {
      console.warn('[dsh-checkpoints] failed to submit composer:', error)
      return false
    }
  }

  /**
   * Fetch a sent message's images back as browser files so the inline editor
   * can show them (and re-send them) like pre-send composer drafts.
   * Failures degrade to a text-only edit for that image.
   */
  const loadEditImages = async (sessionId: string, imageRefs: readonly MessageImageRef[]): Promise<InlineEditImage[]> => {
    if (imageRefs.length === 0) return []
    const binding = sessions.binding(sessionId)
    if (binding === undefined || binding.session.readAttachment === undefined) return []
    const loaded = await Promise.all(imageRefs.map(async (ref): Promise<InlineEditImage | null> => {
      try {
        const result = await binding.session.readAttachment!(ref.attachmentId)
        if (!result.ok || result.value === undefined) return null
        const mediaType = ref.mediaType ?? result.value.attachment.mediaType ?? 'image/png'
        const extension = mediaType.split('/')[1] ?? 'png'
        // Copy into a plain-ArrayBuffer view: the wire bytes may be typed
        // ArrayBufferLike, which File/Blob parts reject under strict lib types.
        const bytes = new Uint8Array(result.value.data)
        const file = new File([bytes], `image.${extension}`, { type: mediaType })
        return { file, previewUrl: URL.createObjectURL(file) }
      } catch (cause) {
        console.warn('[dsh-checkpoints] edit image load failed:', cause)
        return null
      }
    }))
    return loaded.filter((image): image is InlineEditImage => image !== null)
  }

  const openInlineEditor = (sessionId: string, seq: number, text: string, imageRefs: readonly MessageImageRef[], row: HTMLElement, key: string): void => {
    closeInlineEditor(true)

    const openSeq = ++editOpenSeq
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
        initialImages: images,
        modelDirectory: modelDirectoryFor(sessionId),
        onSubmit: async (editedText, _selection, files) => {
          // 1) Ask about file rollback before touching the conversation.
          const rollbackFiles = window.confirm(
            '是否同时回退代码改动到该消息之前？\n\n'
            + '“确定”= 对话和代码一起回退；\n'
            + '“取消”= 只重写对话，代码保持现状。',
          )
          // 2) Remove the original instruction and everything after it.
          const recallResult = await postRecall(sessionId, seq, { rollbackFiles, deleteNewFiles: false })
          // 3) Keep the old rows hidden until the replacement surface commits.
          hiddenKeys = collectHiddenKeys(seq, true)
          refreshShadowedSeqs(sessionId)
          closeInlineEditor(false)
          // 4) Re-register the kept images as fresh composer drafts, then send
          // text + images together through the ordinary composer submit path.
          let restoredImages = 0
          let imageProblem: string | undefined
          if (files.length > 0) {
            try {
              const conversation = ctx.get('conversation') as ConversationFace | undefined
              const scope = sessions.scope(sessionId)
              const input = conversation !== undefined && scope !== undefined ? conversation.input.for(scope) : undefined
              const ids = (conversation?.createDraftImages?.(files) ?? []).map(attachment => attachment.id)
              if (input?.addImages !== undefined && ids.length > 0 && input.addImages(ids)) {
                restoredImages = ids.length
              }
            } catch (cause) {
              console.warn('[dsh-checkpoints] failed to restore edit images:', cause)
            }
            if (restoredImages !== files.length) {
              imageProblem = `有 ${files.length - restoredImages} 张图片未能恢复，编辑后的消息将不包含它们。`
            }
          }
          const draftSet = setDraftFor(sessionId, editedText)
          await new Promise<void>((resolve) => { window.setTimeout(resolve, 0) })
          const submitted = draftSet && submitFor(sessionId)
          scheduleReconcile()
          // 5) The conversation has already been rewound at this point, so any
          // late failure must be reported instead of silently dropping either
          // the file rollback or the edited content.
          const problems: string[] = []
          if (recallResult.filesRestored === false) {
            problems.push(`文件回退失败：${recallResult.fileError ?? '未知原因'}\n（对话已回退，文件保持现状）`)
          }
          if (imageProblem !== undefined) problems.push(imageProblem)
          if (!submitted || (editedText.trim() === '' && files.length > 0 && restoredImages === 0)) {
            problems.push(`编辑内容未能自动发送，请手动粘贴到输入框发送：\n\n${editedText}`)
          }
          if (problems.length > 0) {
            window.alert(problems.join('\n\n———\n\n'))
          }
        },
        onCancel: () => {
          closeInlineEditor(true)
          scheduleReconcile()
        },
      }))
    }

    // Historical images load first so the editor mounts once, with thumbnails
    // already in place (text-only edits resolve immediately).
    void loadEditImages(sessionId, imageRefs).then((images) => {
      if (openSeq !== editOpenSeq || editHost === null) {
        // Superseded by a newer open/close: discard the fetched previews.
        for (const image of images) URL.revokeObjectURL(image.previewUrl)
        return
      }
      mount(images)
    })
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
    void fetchShadowedSeqs(sessionId).then((seqs) => {
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
    return createElement(RoundChangesCard, { sessionId, session: binding.session })
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

  const mo = new MutationObserver(() => {
    if (scrollport !== null && !scrollport.isConnected) {
      teardown('conversation surface detached')
      sync()
      return
    }
    if (scrollport === null) sync()
    scheduleReconcile()
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

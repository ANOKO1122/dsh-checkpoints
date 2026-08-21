/**
 * Inline per-message edit affordance.
 *
 * DSH's built-in user renderer already places a copy icon under every sent
 * user message. Instead of injecting a separate action bar (which visually
 * fought the surrounding chrome), we insert one icon-styled button directly
 * into the built-in actions row, right after the copy button, and hand the
 * row back to the caller when the user clicks it. The caller then mounts the
 * inline editor in place of the original row.
 */

import type { ChatNode, SessionFace } from './context-types.ts'

const EDIT_ATTR = 'data-dsh-checkpoints-edit-action'
const KEY_ATTR = 'data-dsh-checkpoints-key'
const SEQ_ATTR = 'data-dsh-checkpoints-seq'

export interface MessageActionCallbacks {
  readonly onEdit: (seq: number, text: string, row: HTMLElement, key: string) => void
}

/** Extract the plain text from a user/steering node's content blocks. */
export function textOfNode(node: ChatNode): string {
  const data = node.data as { content?: unknown } | undefined
  const content = data?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string } | null
    if (b !== null && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

/** Loose node-data shape for the built-in message clock time. */
interface ClockNodeData {
  readonly content?: unknown
  readonly time?: number
  readonly closing?: { readonly time?: number }
}

/** Epoch ms the built-in message clock renders for a chat node. */
function clockTimeOfNode(node: ChatNode): number | undefined {
  const data = node.data as ClockNodeData | undefined
  if (node.kind === 'turn-tail') {
    if (typeof data?.closing?.time === 'number') return data.closing.time
  }
  return typeof data?.time === 'number' ? data.time : undefined
}

/** `8月18日 `-style prefix for the built-in same-day `HH:mm` clock. */
function monthDayPrefix(time: number): string {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}月${date.getDate()}日 `
}

/**
 * Prepend a month/day prefix to a built-in message clock span that currently
 * shows only `HH:mm` (same calendar day). DSH's own clock already includes the
 * date for earlier messages, so those spans are left untouched.
 */
function patchMessageClockSpan(span: HTMLSpanElement, time: number): void {
  const text = span.textContent ?? ''
  if (!/^\d{1,2}:\d{2}/.test(text)) return
  const prefix = monthDayPrefix(time)
  if (prefix === '') return
  const first = span.firstChild
  if (first !== null && first.nodeType === Node.TEXT_NODE && first.nodeValue === prefix) return
  span.prepend(document.createTextNode(prefix))
}

/** Surface event seq a chat node corresponds to, when it has one. */
function surfaceSeqOfNode(node: ChatNode): number | undefined {
  if (node.kind === 'tool-call') {
    const data = node.data as { root?: { seq?: number } } | undefined
    return typeof data?.root?.seq === 'number' ? data.root.seq : node.anchorSeq
  }
  return node.anchorSeq
}

/** Whether a chat row should be hidden by a server-reported shadowed seq set. */
function isShadowed(node: ChatNode | undefined, shadowedSeqs: ReadonlySet<number> | null): boolean {
  if (node === undefined || shadowedSeqs === null) return false
  const seq = surfaceSeqOfNode(node)
  return seq !== undefined && shadowedSeqs.has(seq)
}

/** Add month/day to the built-in message clock under one rendered chat row. */
function patchRowClock(row: HTMLElement, node: ChatNode | undefined): void {
  if (node === undefined) return
  const time = clockTimeOfNode(node)
  if (time === undefined) return
  const actionsContainer = findActionsRow(row)
  if (actionsContainer === null) return
  const copyButton = actionsContainer.querySelector<HTMLButtonElement>('button')
  if (copyButton === null) return
  const actionsRow = copyButton.parentElement
  if (actionsRow === null) return
  for (const child of [...actionsRow.children]) {
    if (child instanceof HTMLSpanElement) patchMessageClockSpan(child, time)
  }
}

const EDIT_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z" fill="currentColor"/></svg>`

/**
 * Reconcile one inline edit icon after every rendered user/steering row.
 * @param session - the bound session face (snapshot source).
 * @param scrollport - the conversation scroll container.
 * @param hiddenKeys - rows whose keys are hidden after a rewind/recall.
 * @param editingKey - the row currently being edited in place (its display is
 *   owned by the inline editor, not by this reconciler).
 * @param callbacks - the edit callback.
 */
export function reconcileMessageActions(
  session: SessionFace,
  scrollport: HTMLElement,
  hiddenKeys: ReadonlySet<string> | null,
  shadowedSeqs: ReadonlySet<number> | null,
  editingKey: string | null,
  callbacks: MessageActionCallbacks,
): void {
  const chat = session.snapshotCache.chat
  if (!chat) return

  // Apply hidden-key visibility to every rendered chat row (user, assistant,
  // tool, ...), not just user rows. A recall/rewind shadows a whole surface
  // range, so every row after the target must disappear from the visible flow.
  // `hiddenKeys` is the just-performed edit's immediate set; `shadowedSeqs`
  // comes from the server surface fold and survives page reloads.
  const rowByKey = new Map<string, HTMLElement>()
  for (const row of scrollport.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
    const key = row.dataset.chatAnchorKey
    if (key !== undefined) rowByKey.set(key, row)
  }
  for (const [key, row] of rowByKey) {
    if (key === editingKey) continue
    const node = chat.nodes.get(key)
    const hidden = hiddenKeys?.has(key) === true || isShadowed(node, shadowedSeqs)
    const nextDisplay = hidden ? 'none' : ''
    // Writing the same value still dirties style; skip unchanged rows.
    if (row.style.display !== nextDisplay) row.style.display = nextDisplay
    patchRowClock(row, node)
  }

  const userNodes: ChatNode[] = []
  for (const node of chat.nodes.values()) {
    if (node.kind === 'user' || node.kind === 'steering') userNodes.push(node)
  }

  const liveKeys = new Set<string>()
  for (const node of userNodes) {
    const row = rowByKey.get(node.key)
    if (row === undefined) continue
    liveKeys.add(node.key)

    ensureEditAction(row, node, callbacks)
  }

  // Drop edit buttons whose row disappeared or whose node is no longer a
  // user node.
  for (const button of [...scrollport.querySelectorAll<HTMLElement>(`[${EDIT_ATTR}]`)]) {
    const key = button.getAttribute(KEY_ATTR)
    if (key === null || !liveKeys.has(key)) button.remove()
  }
}

/** Find the built-in actions row for a rendered user row. */
function findActionsRow(row: HTMLElement): HTMLElement | null {
  const candidate = row.lastElementChild
  if (candidate instanceof HTMLElement && candidate.querySelector('button') !== null) {
    return candidate
  }
  return null
}

function ensureEditAction(row: HTMLElement, node: ChatNode, callbacks: MessageActionCallbacks): void {
  const actionsRow = findActionsRow(row)
  if (actionsRow === null) return
  const copyButton = actionsRow.querySelector<HTMLButtonElement>('button')
  if (copyButton === null) return

  let editButton = actionsRow.querySelector<HTMLButtonElement>(`[${EDIT_ATTR}]`)
  if (editButton === null) {
    editButton = document.createElement('button')
    editButton.type = 'button'
    editButton.setAttribute(EDIT_ATTR, 'true')
    // Reuse the built-in copy button's hashed action class so the edit icon
    // looks exactly like its sibling (same size, radius, hover, color).
    editButton.className = copyButton.className
    editButton.innerHTML = EDIT_SVG
    editButton.setAttribute('aria-label', '编辑')
    editButton.title = '编辑'
    copyButton.after(editButton)
  }

  editButton.setAttribute(KEY_ATTR, node.key)
  editButton.setAttribute(SEQ_ATTR, String(node.anchorSeq))
  editButton.style.display = ''
  editButton.onclick = () => {
    callbacks.onEdit(node.anchorSeq, textOfNode(node), row, node.key)
  }
}

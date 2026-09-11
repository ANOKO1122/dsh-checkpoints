/** Reposition the mounted Harness rail without copying its private component,
 * moving React-owned DOM, replacing handlers, or depending on CSS-module hashes.
 * The custom-property signature belongs to TurnNavigator's layout contract.
 */
export const NATIVE_RAIL_ATTRIBUTE = 'data-dsh-checkpoints-native-rail'
export const NATIVE_RAIL_CSS = `
[data-conversation-scroll] nav[${NATIVE_RAIL_ATTRIBUTE}] {
  right: auto !important;
  left: calc(12px - (var(--dsh-composer-side-clearance, 0px) + 16px)) !important;
}
[data-conversation-scroll] nav[${NATIVE_RAIL_ATTRIBUTE}] button {
  right: auto !important;
  left: 0 !important;
}
[data-conversation-scroll] nav[${NATIVE_RAIL_ATTRIBUTE}] button::before {
  right: auto !important;
  left: 0 !important;
}
[data-conversation-scroll] nav[${NATIVE_RAIL_ATTRIBUTE}] [role="tooltip"] {
  right: auto !important;
  left: calc(100% + 10px) !important;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, .16));
}
`

const installations = new WeakMap<Document, { refs: number; remove: () => void }>()

/** CSS-only adaptation: native hover, focus, paging and active-turn follow stay intact. */
export function installNativeTurnNavigation(doc: Document = document): () => void {
  const existing = installations.get(doc)
  if (existing) {
    existing.refs++
    return releaseOnce(doc, existing)
  }
  const style = doc.createElement('style')
  style.dataset.dshCheckpointsNativeNavigation = ''
  style.textContent = NATIVE_RAIL_CSS
  doc.head.append(style)
  const tagged = new Set<HTMLElement>()
  const sync = (): void => {
    for (const node of tagged) {
      if (!node.isConnected) { node.removeAttribute(NATIVE_RAIL_ATTRIBUTE); tagged.delete(node) }
    }
    for (const nav of doc.querySelectorAll<HTMLElement>('[data-conversation-scroll] nav[style]')) {
      if (!nav.style.getPropertyValue('--turn-natural-height')
        || !nav.style.getPropertyValue('--turn-rail-inset')
        || !nav.querySelector('button[aria-label]')) continue
      if (!nav.hasAttribute(NATIVE_RAIL_ATTRIBUTE)) {
        nav.setAttribute(NATIVE_RAIL_ATTRIBUTE, 'left')
        tagged.add(nav)
      }
    }
  }
  sync()
  const Observer = doc.defaultView?.MutationObserver
  const observer = Observer ? new Observer(records => {
    if ([...tagged].some(nav => !nav.isConnected) || records.some(record =>
      [...record.addedNodes].some(node => node.nodeType === 1
        && ((node as Element).matches('nav') || (node as Element).querySelector('nav'))))) sync()
  }) : undefined
  // No attribute/scroll observer: active ticks and streaming deltas keep native
  // performance. Only added/removed rails and lazy history mounts need discovery.
  observer?.observe(doc.body, { childList: true, subtree: true })
  const installation = { refs: 1, remove: () => {
    observer?.disconnect()
    for (const nav of tagged) nav.removeAttribute(NATIVE_RAIL_ATTRIBUTE)
    tagged.clear()
    style.remove()
    installations.delete(doc)
  } }
  installations.set(doc, installation)
  return releaseOnce(doc, installation)
}

function releaseOnce(doc: Document, installation: { refs: number; remove: () => void }): () => void {
  let released = false
  return () => {
    if (released || installations.get(doc) !== installation) return
    released = true
    if (--installation.refs === 0) installation.remove()
  }
}

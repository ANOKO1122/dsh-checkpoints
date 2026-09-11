/** Stable public chat anchor, independent of translated text and CSS classes. */
export function findAnchorRow(scrollport: HTMLElement, key: string): HTMLElement | null {
  for (const el of scrollport.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
    if (el.dataset.chatAnchorKey === key) return el
  }
  return null
}

export function scrollToRow(scrollport: HTMLElement, row: HTMLElement): void {
  const rowRect = row.getBoundingClientRect()
  const spRect = scrollport.getBoundingClientRect()
  const top = Math.max(0, scrollport.scrollTop + rowRect.top - spRect.top - spRect.height / 2 + rowRect.height / 2)
  if (typeof scrollport.scrollTo === 'function') scrollport.scrollTo({ top, behavior: 'smooth' })
  else scrollport.scrollTop = top
}

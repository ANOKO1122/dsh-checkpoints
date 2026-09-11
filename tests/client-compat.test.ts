import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { adaptSessions } from '../src/client/runtime-session.ts'
import { reconcileMessageActions } from '../src/client/message-actions.ts'
import { findAnchorRow, scrollToRow } from '../src/client/navigation.ts'
import type { SessionsFace, SessionFace, ChatSnapshot } from '../src/client/context-types.ts'

test('new chat target restores sent-message edit button, click content, and shadow hiding', () => {
  const dom = new JSDOM('<div id="scroll"><div data-chat-anchor-key="user:5"><p>original</p><div><button>Copy</button></div></div></div>')
  const restore = ['document', 'Node', 'HTMLElement', 'HTMLSpanElement'].map(name => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value: (dom.window as any)[name] })
    return () => original ? Object.defineProperty(globalThis, name, original) : delete (globalThis as any)[name]
  })
  try {
    const node = { key: 'user:5', kind: 'user', anchorSeq: 5, data: { content: [{ type: 'text', text: 'original' }] } }
    let chat: ChatSnapshot = { order: [node.key], nodes: new Map([[node.key, node]]) }
    let chatListener = () => {}, unsubscribed = 0, through = -1
    const binding = { sessionId: 's', session: {
      sessionId: 's', getSnapshot: () => ({ sessionId: 's', hasMore: true }),
      subscribe: () => () => { unsubscribed++ },
      loadThrough: async (seq: number) => { through = seq },
    } as unknown as SessionFace }
    const sessions = adaptSessions({
      list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
      binding: () => binding, scope: () => ({}), open: () => {},
    } as SessionsFace, () => ({ getSnapshot: () => chat, subscribe: listener => {
      chatListener = listener; return () => { unsubscribed++ }
    } }))
    const adapted = sessions.binding('s')!
    assert.equal(adapted, sessions.binding('s'))
    assert.equal(adapted.session.snapshotCache.chat, chat)
    let notifications = 0
    const off = adapted.session.subscribe(() => notifications++)
    chat = { ...chat, order: [...chat.order] }; chatListener()
    assert.equal(notifications, 1)
    void adapted.session.loadThrough!(5)
    assert.equal(through, 5)
    const scroll = dom.window.document.getElementById('scroll')!
    let clicked: unknown
    const callbacks = { onEdit: (seq: number, text: string) => { clicked = { seq, text } } }
    reconcileMessageActions(adapted.session, scroll, null, null, null, callbacks)
    reconcileMessageActions(adapted.session, scroll, null, null, null, callbacks)
    const buttons = scroll.querySelectorAll<HTMLButtonElement>('[data-dsh-checkpoints-edit-action]')
    assert.equal(buttons.length, 1)
    buttons[0]!.click()
    assert.deepEqual(clicked, { seq: 5, text: 'original' })
    reconcileMessageActions(adapted.session, scroll, null, new Set([5]), null, callbacks)
    assert.equal(findAnchorRow(scroll, 'user:5')!.style.display, 'none')
    off(); assert.equal(unsubscribed, 2)
  } finally { restore.reverse().forEach(fn => fn()); dom.window.close() }
})

test('checkpoint centers the exact stable anchor in the conversation scrollport', () => {
  const dom = new JSDOM('<div id="scroll"><div data-chat-anchor-key="user:5"></div></div>')
  const scroll = dom.window.document.getElementById('scroll')!
  const row = findAnchorRow(scroll, 'user:5')!
  scroll.scrollTop = 100
  scroll.getBoundingClientRect = () => ({ top: 50, height: 400 } as DOMRect)
  row.getBoundingClientRect = () => ({ top: 800, height: 100 } as DOMRect)
  let target: ScrollToOptions | undefined
  scroll.scrollTo = ((options: ScrollToOptions) => { target = options }) as typeof scroll.scrollTo
  scrollToRow(scroll, row)
  assert.deepEqual(target, { top: 700, behavior: 'smooth' })
  assert.equal(findAnchorRow(scroll, 'missing'), null)
  dom.window.close()
})

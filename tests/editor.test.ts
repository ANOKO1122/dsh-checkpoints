import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'

test('inline editor retains draft on failed send, blocks double send and has explicit rollback scope', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'KeyboardEvent', 'sessionStorage']) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] })
  }
  const hooks = registerHooks({ load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }
    return next(url, context)
  } })
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const { createElement, act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { InlineEdit } = await import('../src/client/inline-edit.tsx')
  const host = document.getElementById('root')!
  const root = createRoot(host)
  let reject!: (error: Error) => void
  let calls = 0, cancelled = 0
  const pending = new Promise<void>((_resolve, no) => { reject = no })
  try {
    await act(async () => root.render(createElement(InlineEdit, {
      sessionId: 'test', initialText: 'preserve this edit', draftKey: 'test-draft', modelDirectory: null,
      onSubmit: async (text, _selection, _files, rollback) => {
        calls++
        assert.equal(text, 'preserve this edit')
        assert.equal(rollback, true)
        return pending
      },
      onCancel: () => { cancelled++ },
    })))
    const scope = host.querySelector('select')!
    assert.equal(scope.value, 'false')
    await act(async () => { scope.value = 'true'; scope.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
    const send = host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!
    await act(async () => { send.click(); send.click() })
    assert.equal(calls, 1)
    assert.equal(send.disabled, true)
    await act(async () => host.querySelector('textarea')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(cancelled, 0)
    await act(async () => { reject(new Error('host rejected')) })
    assert.equal(host.querySelector('textarea')!.value, 'preserve this edit')
    assert.equal(sessionStorage.getItem('test-draft'), 'preserve this edit')
    assert.match(host.textContent!, /host rejected/)
    assert.equal(send.disabled, false)
    const cancel = [...host.querySelectorAll('button')].find(button => button.textContent === '取消')!
    await act(async () => cancel.click())
    assert.equal(cancelled, 1)
    assert.equal(calls, 1)
  } finally {
    await act(async () => root.unmount())
    hooks.deregister()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as any)[key]
    }
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  }
})

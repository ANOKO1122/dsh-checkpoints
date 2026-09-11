import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { registerHooks } from 'node:module'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { installNativeTurnNavigation, NATIVE_RAIL_ATTRIBUTE } from '../src/client/native-turn-navigation.ts'

const railHtml = '<nav style="--turn-natural-height:22px;--turn-rail-inset:6px"><button aria-label="Turn 1"></button><div role="tooltip">preview</div></nav>'

test('native rail is adapted in-place, unrelated navs are untouched, and cleanup restores original DOM', async () => {
  const dom = new JSDOM(`<head></head><body><nav id="unrelated"></nav><div data-conversation-scroll>${railHtml}</div></body>`)
  const doc = dom.window.document
  const rail = doc.querySelector('[data-conversation-scroll] nav')!
  const parent = rail.parentElement
  let clicks = 0
  rail.addEventListener('click', () => clicks++)
  const dispose = installNativeTurnNavigation(doc)
  const second = installNativeTurnNavigation(doc)
  assert.equal(rail.getAttribute(NATIVE_RAIL_ATTRIBUTE), 'left')
  assert.equal(rail.parentElement, parent)
  assert.equal(doc.getElementById('unrelated')!.hasAttribute(NATIVE_RAIL_ATTRIBUTE), false)
  assert.equal(doc.querySelectorAll('style').length, 1)
  ;(rail.querySelector('button') as HTMLElement).click()
  assert.equal(clicks, 1)
  assert.equal(dom.window.getComputedStyle(rail).right, 'auto')
  assert.equal(dom.window.getComputedStyle(rail.querySelector('[role="tooltip"]')!).right, 'auto')
  dispose(); dispose()
  assert.equal(rail.hasAttribute(NATIVE_RAIL_ATTRIBUTE), true)
  second()
  assert.equal(rail.hasAttribute(NATIVE_RAIL_ATTRIBUTE), false)
  assert.equal(doc.querySelectorAll('style').length, 0)
  assert.equal(rail.parentElement, parent)
  dom.window.close()
})

test('late native rail mounts and session replacements are discovered without creating a second rail', async () => {
  const dom = new JSDOM('<head></head><body><div data-conversation-scroll></div></body>')
  const doc = dom.window.document
  const dispose = installNativeTurnNavigation(doc)
  const scroll = doc.querySelector('[data-conversation-scroll]')!
  scroll.innerHTML = railHtml
  await new Promise(resolve => setTimeout(resolve, 0))
  const first = scroll.querySelector('nav')!
  assert.equal(first.getAttribute(NATIVE_RAIL_ATTRIBUTE), 'left')
  scroll.innerHTML = railHtml
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(first.hasAttribute(NATIVE_RAIL_ATTRIBUTE), false)
  assert.equal(scroll.querySelectorAll(`nav[${NATIVE_RAIL_ATTRIBUTE}]`).length, 1)
  dispose()
  scroll.innerHTML = railHtml
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(scroll.querySelector(`nav[${NATIVE_RAIL_ATTRIBUTE}]`), null)
  dom.window.close()
})

async function withReactDom(run: (runtime: any) => Promise<void>) {
  const dom = new JSDOM('<head></head><body><div data-conversation-scroll><div id="root"></div></div></body>', { url: 'http://localhost/' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Event', 'sessionStorage']) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] })
  }
  const require = createRequire(import.meta.url)
  const reactUrls = new Map(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'].map(name => [name, pathToFileURL(require.resolve(name)).href]))
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      // The optional upstream fixture must use the same React dispatcher as
      // this test's renderer, not a second monorepo dependency instance.
      const url = reactUrls.get(specifier)
      if (url) return { url, shortCircuit: true }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }
      return next(url, context)
    },
  })
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const { createElement, act } = await import('react')
  // Upstream TSX is normally compiled by its browser bundler; the standalone
  // source fixture may inherit a classic JSX config from the monorepo.
  originals.set('React', Object.getOwnPropertyDescriptor(globalThis, 'React'))
  Object.defineProperty(globalThis, 'React', { configurable: true, value: await import('react') })
  const { createRoot } = await import('react-dom/client')
  const host = document.getElementById('root')!
  const root = createRoot(host)
  try { await run({ dom, host, root, createElement, act }) }
  finally {
    await act(async () => root.unmount())
    hooks.deregister()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as any)[key]
    }
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  }
}

test('file drawer contains only file changes and never requests checkpoint list', async () => withReactDom(async ({ root, host, createElement, act }) => {
  const { CheckpointSidebarPanel } = await import('../src/client/sidebar.tsx')
  const oldFetch = globalThis.fetch
  const requested: string[] = []
  globalThis.fetch = (async (url: string) => {
    requested.push(String(url))
    return new Response(JSON.stringify({ ok: true, value: { files: [], totalAdditions: 0, totalDeletions: 0 } }))
  }) as typeof fetch
  try {
    await act(async () => root.render(createElement(CheckpointSidebarPanel, {
      session: { sessionId: 'file-only', subscribe: () => () => {} }, onClose: () => {},
    })))
    assert.equal(host.querySelector('[aria-label="文件改动"]') !== null, true)
    assert.ok(!host.textContent.includes('检查点'))
    assert.equal(requested.length, 1)
    assert.ok(requested[0]!.includes('/diff?'))
    assert.ok(!requested.some(url => url.includes('/list?')))
  } finally { globalThis.fetch = oldFetch }
}))

test('actual Harness rail retains hover, active marker and native click navigation', { skip: !process.env.DSH_HARNESS_ROOT }, async () => withReactDom(async ({ dom, root, host, createElement, act }) => {
  const { TurnNavigator } = await import(pathToFileURL(join(process.env.DSH_HARNESS_ROOT!, 'packages/client/ui-chat/src/client/chat/TurnNavigator.tsx')).href)
  const items = [1, 2].map(turn => ({ turn, prompt: `prompt ${turn}`, response: `response ${turn}`, anchor: { kind: 'loaded', key: `turn:${turn}` } }))
  const navigated: number[] = []
  const dispose = installNativeTurnNavigation(document)
  try {
    await act(async () => root.render(createElement(TurnNavigator, { items, activeTurn: 1, busyTurn: null,
      onNavigate: (item: any) => navigated.push(item.turn), t: (key: string) => key,
    })))
    const rail = host.querySelector('nav')!
    assert.equal(rail.getAttribute(NATIVE_RAIL_ATTRIBUTE), 'left')
    assert.equal(host.querySelectorAll('nav').length, 1)
    assert.equal(host.querySelectorAll('[aria-current="true"]').length, 1)
    rail.getBoundingClientRect = () => ({ top: 100 } as DOMRect)
    await act(async () => rail.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientY: 106 })))
    assert.match(host.querySelector('[role="tooltip"]')!.textContent!, /prompt 1.*response 1/)
    await act(async () => rail.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientY: 116 })))
    assert.deepEqual(navigated, [2])
    await act(async () => host.querySelector('button')!.click())
    assert.deepEqual(navigated, [2, 1])
  } finally { dispose() }
}))

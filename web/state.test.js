import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://localhost/#session/demo' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.location = dom.window.location
globalThis.history = dom.window.history
window.__ANVIL_TEST__ = true

const { h, render } = await import('preact')
const { act } = await import('preact/test-utils')
const sessionsModule = await import('./src/sessions.jsx')
const detailModule = await import('./src/detail.jsx')
const { AppShell } = await import('./src/app.jsx')
const state = await import('./src/state.js')

const session = { id: 'demo', project: 'Demo', work_branch: 'feature/search', environment_state: 'ready', execution_state: 'idle', created_at: '2026-09-19T11:00:00Z', sandbox: 'sandbox', repository: 'https://example.test/repo', base_ref: 'main' }
const activity = (execution_state = 'running') => ({
  session,
  environment_state: 'ready',
  execution_state,
  attach_command: 'anvilctl attach demo',
  lifecycle: [{ kind: 'created', at: '2026-09-19T11:00:00Z' }],
  requests: [{ id: 'request-1', number: 1, origin: 'operator', state: 'running', started_at: '2026-09-19T11:58:00Z', last_activity_at: '2026-09-19T11:59:00Z', prompt: 'x'.repeat(550) }],
})

test('elapsed display and explicit Sessions routes stay deterministic', () => {
  assert.equal(state.elapsed('2026-09-19T11:58:00Z', Date.parse('2026-09-19T12:00:10Z')), '2m 10s')
  assert.equal(state.elapsed('1789819200Z', Date.parse('2026-09-19T12:00:10Z')), '10s')
  assert.equal(state.routeFromHash('#sessions'), null)
  assert.equal(state.routeFromHash('#providers'), null)
  assert.equal(state.routeFromHash('#settings'), null)
  assert.equal(state.routeFromHash('#session/demo%2Fdrawer'), 'demo/drawer')
  assert.equal(state.routeFor(null), '#sessions')
  assert.equal(state.routeFor('demo/drawer'), '#session/demo%2Fdrawer')
})

test('search and factual filters compose with AND and use session fallback values', () => {
  state.sessions.value = [session]
  state.activities.value = new Map()
  state.search.value = 'FEATURE/SEARCH'
  state.environmentFilter.value = 'ready'
  state.executionFilter.value = 'idle'
  assert.deepEqual(state.visibleSessions.value.map((item) => item.id), ['demo'])
  state.search.value = 'missing'
  assert.deepEqual(state.visibleSessions.value, [])
  state.search.value = ''
  state.environmentFilter.value = 'suspended'
  assert.deepEqual(state.visibleSessions.value, [])
  state.search.value = ''
  state.environmentFilter.value = ''
  state.executionFilter.value = ''
})

test('selected factual filter values remain represented when absent from current data', async () => {
  state.loading.value = false
  state.error.value = null
  state.sessions.value = [session]
  state.activities.value = new Map([[session.id, activity('idle')]])
  state.environmentFilter.value = 'failed'
  state.executionFilter.value = 'unavailable'
  const root = document.getElementById('app')
  await act(async () => render(h(sessionsModule.SessionsWorkspace), root))
  assert.equal(root.querySelector('#environment-filter').value, 'failed')
  assert.equal(root.querySelector('#execution-filter').value, 'unavailable')
  assert.ok([...root.querySelector('#environment-filter').options].some((option) => option.value === 'failed'))
  assert.ok([...root.querySelector('#execution-filter').options].some((option) => option.value === 'unavailable'))
  state.environmentFilter.value = ''
  state.executionFilter.value = ''
  render(null, root)
})

function TestApp() {
  return h('div', { class: `app-shell ${state.selected.value ? 'mobile-detail' : ''}` },
    h('main', { class: 'workspace' }, h('nav', { class: 'app-rail' }), h(sessionsModule.SessionsWorkspace), h(detailModule.SessionDetail)))
}

test('keyed rows and selected factual detail remain mounted across polls', async () => {
  state.loading.value = false
  state.error.value = null
  state.sessions.value = [session]
  state.activities.value = new Map([[session.id, activity('running')]])
  state.selected.value = session.id
  const root = document.getElementById('app')
  await act(async () => render(h(TestApp), root))
  const row = root.querySelector('[data-session="demo"]')
  const detail = root.querySelector('.detail')
  assert.match(row.textContent, /Environment: ready/)
  assert.match(row.textContent, /Execution: running/)
  assert.equal(root.querySelectorAll('.session-status-label').length, 0)
  assert.doesNotMatch(root.textContent, /Work state|Ready for review|Done|Needs input/)
  await act(async () => {
    state.sessions.value = [{ ...session }]
    state.activities.value = new Map([[session.id, activity('idle')]])
  })
  assert.equal(root.querySelector('[data-session="demo"]'), row)
  assert.equal(root.querySelector('.detail'), detail)
  assert.match(row.textContent, /Environment: ready/)
  assert.match(row.textContent, /Execution: idle/)
  render(null, root)
})

test('per-session attach, prompt expansion, tab, focus, and scroll state survive updates', async () => {
  state.loading.value = false
  state.error.value = null
  state.sessions.value = [session]
  state.activities.value = new Map([[session.id, activity()]])
  state.selected.value = session.id
  const root = document.getElementById('app')
  const ui = state.sessionUI(session.id)
  await act(async () => render(h(TestApp), root))
  const detail = root.querySelector('.detail')
  detail.scrollTop = 64
  const attach = root.querySelector('details')
  attach.open = true
  await act(async () => { attach.dispatchEvent(new window.Event('toggle')) })
  await act(async () => root.querySelector('.prompt-toggle').click())
  await act(async () => root.querySelector('#runtime-tab').click())
  root.querySelector('#runtime-tab').focus()
  assert.equal(ui.attachOpen.value, true)
  assert.equal(root.querySelector('.prompt').classList.contains('expanded'), true)
  assert.equal(ui.tab.value, 'runtime')
  await act(async () => { state.activities.value = new Map([[session.id, activity('idle')]]) })
  assert.equal(root.querySelector('.detail'), detail)
  assert.equal(root.querySelector('details').open, true)
  assert.equal(root.querySelector('.prompt').classList.contains('expanded'), true)
  assert.equal(root.querySelector('#runtime-panel').hidden, false)
  assert.equal(document.activeElement.id, 'runtime-tab')
  assert.equal(detail.scrollTop, 64)
  render(null, root)
})

test('filtering leaves the selected factual detail open and offers to clear filters', async () => {
  state.loading.value = false
  state.error.value = null
  state.sessions.value = [session]
  state.activities.value = new Map([[session.id, activity('idle')]])
  state.selected.value = session.id
  state.search.value = ''
  state.environmentFilter.value = ''
  state.executionFilter.value = ''
  const root = document.getElementById('app')
  await act(async () => render(h(TestApp), root))
  state.executionFilter.value = 'running'
  await act(async () => {})
  assert.equal(state.selected.value, session.id)
  assert.equal(root.querySelector('[data-session="demo"]'), null)
  assert.match(root.querySelector('.filter-context').textContent, /hidden by the current search or runtime filters/)
  await act(async () => root.querySelector('.filter-context button').click())
  assert.equal(state.executionFilter.value, '')
  assert.ok(root.querySelector('[data-session="demo"]'))
  assert.equal(state.selected.value, session.id)
  render(null, root)
})

test('direct links and browser history return to a useful Sessions landing', async () => {
  state.loading.value = false
  state.error.value = null
  state.sessions.value = [session]
  state.activities.value = new Map([[session.id, activity()]])
  state.selected.value = 'demo'
  const root = document.getElementById('app')
  await act(async () => render(h(AppShell), root))
  assert.equal(root.querySelector('.app-shell').classList.contains('mobile-detail'), true)
  await act(async () => { state.navigate(null); window.dispatchEvent(new window.PopStateEvent('popstate')) })
  assert.equal(state.routeFromHash(), null)
  assert.equal(root.querySelector('.detail h2'), null)
  assert.equal(root.querySelector('.session-workspace h1').textContent, 'Sessions')
  render(null, root)
})

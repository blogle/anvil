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
const app = await import('./src/app.jsx')
const state = await import('./src/state.js')

const session = { id: 'demo', project: 'Demo', work_branch: 'main', environment_state: 'ready', work_state: 'in_progress', created_at: '2026-09-19T11:00:00Z', sandbox: 'sandbox', repository: 'https://example.test/repo', base_ref: 'main' }
const activity = (execution_state = 'running', summary = 'First') => ({ session, environment_state: 'ready', execution_state, work_state: execution_state === 'idle' ? 'ready_for_review' : 'in_progress', work_state_changed_at: '2026-09-19T11:58:00Z', work_state_summary: summary, attach_command: 'anvilctl attach demo', lifecycle: [{ kind: 'created', at: '2026-09-19T11:00:00Z' }], requests: [{ id: 'request-1', number: 1, origin: 'operator', state: 'running', started_at: '2026-09-19T11:58:00Z', last_activity_at: '2026-09-19T11:59:00Z', prompt: 'x'.repeat(550) }] })

test('elapsed display and status mappings retain current-main semantics', () => {
  assert.equal(state.elapsed('2026-09-19T11:58:00Z', Date.parse('2026-09-19T12:00:10Z')), '2m 10s')
  assert.equal(state.elapsed('1789819200Z', Date.parse('2026-09-19T12:00:10Z')), '10s')
  assert.equal(state.statusFor({ environment_state: 'ready', execution_state: 'idle', work_state: 'in_progress' }), 'ready-for-review')
  assert.equal(state.statusFor({ environment_state: 'suspended', execution_state: 'recovering' }), 'stopped')
  state.sessions.value = [session]
  state.activities.value = new Map([[session.id, activity('idle')]])
  state.filter.value = 'ready-for-review'
  assert.deepEqual(state.visibleSessions.value.map((item) => item.id), ['demo'])
  state.filter.value = 'working'
  assert.deepEqual(state.visibleSessions.value, [])
  state.filter.value = 'all'
})

function TestApp() { return h('div', { class: 'app-shell' }, h('aside', { class: 'sidebar' }, h('div', { class: 'session-list' }, state.sessions.value.map((item) => h(app.SessionRow, { key: item.id, session: item })))), h(app.SessionDetail)) }

test('keyed rows and selected detail remain mounted across polls and status transitions', async () => {
  state.sessions.value = [session]
  state.activities.value = new Map([[session.id, activity()]])
  state.selected.value = session.id
  const root = document.getElementById('app')
  await act(async () => render(h(TestApp), root))
  const row = root.querySelector('[data-session="demo"]')
  const detail = root.querySelector('.detail')
  assert.equal(root.querySelectorAll('.session-status-label').length, 1)
  await act(async () => {
    state.sessions.value = [{ ...session }]
    state.activities.value = new Map([[session.id, activity('running', 'Updated metadata')]])
  })
  assert.equal(root.querySelector('[data-session="demo"]'), row)
  assert.equal(root.querySelector('.detail'), detail)
  assert.equal(root.querySelector('.session-status-label').textContent, 'Working')
  await act(async () => { state.activities.value = new Map([[session.id, activity('idle')]]) })
  assert.equal(root.querySelector('[data-session="demo"]'), row)
  assert.equal(root.querySelector('.session-status-label').textContent, 'Ready for review')
  assert.equal(root.querySelectorAll('.session-status-label').length, 1)
  render(null, root)
})

test('per-session attach, prompt expansion, tab, focus, selection and scroll state survives updates', async () => {
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
  await act(async () => { state.activities.value = new Map([[session.id, activity('running', 'Updated')]]) })
  assert.equal(root.querySelector('.detail'), detail)
  assert.equal(root.querySelector('details').open, true)
  assert.equal(root.querySelector('.prompt').classList.contains('expanded'), true)
  assert.equal(root.querySelector('#runtime-panel').hidden, false)
  assert.equal(document.activeElement.id, 'runtime-tab')
  assert.equal(detail.scrollTop, 64)
  render(null, root)
})

test('direct links and browser history route deterministically; list adapts at mobile breakpoint', async () => {
  assert.equal(state.routeFromHash('#session/demo'), 'demo')
  state.sessions.value = [session]
  state.activities.value = new Map([[session.id, activity()]])
  state.selected.value = 'demo'
  const root = document.getElementById('app')
  await act(async () => render(h(app.AppShell), root))
  assert.equal(root.querySelector('.app-shell').classList.contains('mobile-detail'), true)
  await act(async () => { state.navigate(null); window.dispatchEvent(new window.PopStateEvent('popstate')) })
  assert.equal(state.routeFromHash(), null)
  assert.match(root.querySelector('.detail .empty').textContent, /Select a session/)
  render(null, root)
})

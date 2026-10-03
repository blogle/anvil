import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'

test('production browser retains sessions, detail interactions, routes, and mobile layout', async () => {
  const session = { id: 'demo', project: 'Demo', work_branch: 'main', environment_state: 'ready', work_state: 'in_progress', created_at: '2026-09-19T11:00:00Z', sandbox: 'sandbox', repository: 'https://example.test/repo', base_ref: 'main' }
  const sessions = [session, ...Array.from({ length: 47 }, (_, index) => ({ ...session, id: `demo-${index}`, project: `Project ${index}`, work_branch: `branch-${index}` }))]
  const state = { summary: `Initial metadata ${'long summary '.repeat(500)}`, execution: 'idle', workState: 'ready_for_review', changedAt: new Date(Date.now() - 1000).toISOString() }
  const activity = (id) => {
    const item = sessions.find((entry) => entry.id === id) || session
    const staticState = id === 'demo-1' ? 'working' : id === 'demo-2' ? 'done' : id === 'demo-3' ? 'problem' : 'review'
    const execution = id === 'demo' ? state.execution : staticState === 'working' ? 'running' : 'idle'
    const work = id === 'demo' ? state.workState : staticState === 'done' ? 'completed' : staticState === 'review' ? 'ready_for_review' : 'in_progress'
    return { session: item, environment_state: staticState === 'problem' ? 'failed' : 'ready', execution_state: execution, work_state: work, work_state_changed_at: state.changedAt, work_state_summary: id === 'demo' ? state.summary : `Representative ${staticState} session`, attach_command: `anvilctl sessions attach ${id}`, preview_url: 'https://preview.example.test', opencode_url: 'https://opencode.example.test', lifecycle: [{ kind: 'created', at: '2026-09-19T11:00:00Z' }, { kind: 'ready', at: '2026-09-19T11:01:00Z', detail: 'Sandbox ready' }], requests: [{ id: 'request-1', number: 1, origin: 'operator', state: 'running', started_at: '2026-09-19T11:58:00Z', last_activity_at: '2026-09-19T11:59:00Z', prompt: `selection anchor ${'long prompt '.repeat(500)}` }] }
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/__test/change-selected' && request.method === 'POST') {
      state.execution = 'running'; state.workState = 'in_progress'; state.changedAt = new Date().toISOString(); state.summary = `Updated selected metadata ${'long summary '.repeat(500)}`
      response.writeHead(204); response.end(); return
    }
    if (url.pathname === '/v1/sessions') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(sessions)); return
    }
    const activityMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/activity$/)
    if (activityMatch) {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(activity(decodeURIComponent(activityMatch[1])))); return
    }
    const path = url.pathname === '/' || !url.pathname.startsWith('/assets/') ? 'index.html' : url.pathname.slice(1)
    try {
      const body = await readFile(join(import.meta.dirname, 'dist', path))
      const type = extname(path) === '.html' ? 'text/html' : extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'application/octet-stream'
      response.writeHead(200, { 'content-type': type }); response.end(body)
    } catch { response.writeHead(404); response.end('not found') }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const executablePath = process.env.CHROMIUM_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim()
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${origin}/#sessions`)
    const workspace = page.locator('.session-workspace')
    const detail = page.locator('.detail')
    const row = page.locator('[data-session="demo"]')
    await row.waitFor()
    assert.equal(await page.locator('.app-rail [aria-label="Sessions"]').count(), 1)
    assert.equal(await detail.locator('h2').count(), 0, 'Sessions landing is useful without a selected session')
    assert.equal(await page.getByText('Select a session').count(), 0)
    assert.ok(await workspace.evaluate((element) => element.getBoundingClientRect().width > 900), 'desktop workspace uses the primary width')
    assert.equal(await page.locator('.session-row').count(), sessions.length)
    assert.ok(await workspace.evaluate((element) => element.scrollHeight > element.clientHeight), 'session workspace has its own scroll context')
    await workspace.evaluate((element) => { element.scrollTop = 160 })

    await page.locator('[data-session="demo-1"]').click()
    await page.waitForFunction(() => location.hash === '#session/demo-1')
    assert.equal(await detail.locator('h2').textContent(), 'Project 1 session')
    assert.ok(await detail.evaluate((element) => element.getBoundingClientRect().left > 700), 'selected session opens a desktop right drawer')
    await page.goBack()
    await page.waitForFunction(() => location.hash === '#sessions')
    await page.goForward()
    await page.waitForFunction(() => location.hash === '#session/demo-1')
    await page.locator('[data-filter="ready-for-review"]').click()
    assert.equal(await detail.locator('.filter-context').isVisible(), true, 'filtering keeps the selected drawer open with context')
    assert.equal(await page.locator('[data-session="demo-1"]').count(), 0, 'the list filter still hides non-matching sessions')
    await workspace.evaluate((element) => { element.scrollTop = 160 })
    await page.locator('.back-link').click()
    await page.waitForFunction(() => location.hash === '#sessions')
    assert.equal(await page.locator('[data-filter="ready-for-review"]').getAttribute('aria-pressed'), 'true')
    assert.equal(await workspace.evaluate((element) => element.scrollTop), 160, 'closing retains filter and workspace scroll')
    await page.goBack()
    await page.waitForFunction(() => location.hash === '#session/demo-1')
    await page.goForward()
    await page.waitForFunction(() => location.hash === '#sessions')

    await page.locator('[data-filter="all"]').click()
    await row.click()
    await page.waitForFunction(() => location.hash === '#session/demo')
    assert.equal(await detail.locator('h2').textContent(), 'Demo session', 'direct selection opens the detail drawer')
    await page.locator('#logs-tab').waitFor()
    assert.equal(await row.locator('.session-status-label').count(), 1)
    const initialElapsed = await row.locator('.row-detail').textContent()
    await page.evaluate(() => {
      window.initialRow = document.querySelector('[data-session="demo"]')
      window.initialDetail = document.querySelector('.detail')
      window.initialTabs = document.querySelector('.tabs')
      window.initialActions = document.querySelector('.actions')
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.waitForTimeout(100)
    await page.waitForTimeout(1100)
    assert.equal(await row.evaluate((element) => element === window.initialRow), true)
    assert.notEqual(await row.locator('.row-detail').textContent(), initialElapsed)

    await page.locator('.attach summary').click()
    const promptToggle = page.locator('.prompt-toggle')
    await promptToggle.scrollIntoViewIfNeeded(); await promptToggle.click()
    const prompt = page.locator('.prompt')
    await page.locator('#runtime-tab').click(); await page.locator('#runtime-tab').focus()
    const expectedDetailScroll = await detail.evaluate((element) => { element.style.height = '500px'; element.style.bottom = 'auto'; element.scrollTop = Math.min(50, element.scrollHeight - element.clientHeight); return element.scrollTop })
    assert.ok(expectedDetailScroll > 0, 'detail drawer fixture has a scrollable content region')
    const runtimeTab = page.locator('#runtime-tab')
    await page.evaluate(() => {
      window.initialSelectedDetailNodes = {
        detail: document.querySelector('.detail'), shell: document.querySelector('.detail-inner'), header: document.querySelector('.detail-header'),
        actions: document.querySelector('.actions'), tabs: document.querySelector('.tabs'), logs: document.querySelector('#logs-panel'),
        runtime: document.querySelector('#runtime-panel'), row: document.querySelector('[data-session="demo"]'), focus: document.activeElement,
      }
    })
    state.execution = 'running'; state.workState = 'in_progress'; state.changedAt = new Date().toISOString(); state.summary = `Updated metadata ${'long summary '.repeat(500)}`
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.getByText('Updated metadata').waitFor()
    assert.equal(await detail.locator('.detail-status strong').textContent(), 'Working')
    for (const [selector, key] of [['.detail', 'detail'], ['.detail-inner', 'shell'], ['.detail-header', 'header'], ['.actions', 'actions'], ['.tabs', 'tabs'], ['#logs-panel', 'logs'], ['#runtime-panel', 'runtime'], ['[data-session="demo"]', 'row']]) {
      assert.equal(await page.locator(selector).evaluate((element, name) => element === window.initialSelectedDetailNodes[name], key), true, `${selector} remains mounted during selected-session updates`)
    }
    assert.equal(await row.locator('.session-status-label').count(), 1)
    assert.equal((await row.locator('.row-detail').textContent()).includes('Working'), false, 'elapsed time does not duplicate row status')
    assert.equal(await runtimeTab.evaluate((element) => element === document.activeElement), true, 'drawer focus survives selected-session updates')
    assert.equal(await runtimeTab.getAttribute('aria-selected'), 'true')
    assert.equal(await detail.evaluate((element) => element.scrollTop), expectedDetailScroll)
    assert.equal(await page.locator('details').evaluate((element) => element.open), true)
    assert.equal(await prompt.evaluate((element) => element.classList.contains('expanded')), true)

    await page.locator('.back-link').click()
    await page.waitForFunction(() => location.hash === '#sessions')
    await page.goBack()
    await page.waitForFunction(() => location.hash === '#session/demo')
    await page.goForward()
    await page.waitForFunction(() => location.hash === '#sessions')

    const direct = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await direct.goto(`${origin}/#session/demo`)
    await direct.locator('[data-session-detail] h2').waitFor({ state: 'attached' })
    assert.equal(await direct.locator('.detail h2').textContent(), 'Demo session', 'direct deep links open the drawer')
    await direct.close()

    const tablet = await browser.newPage({ viewport: { width: 900, height: 900 } })
    await tablet.goto(`${origin}/#session/demo`)
    await tablet.locator('[data-session-detail] h2').waitFor({ state: 'attached' })
    assert.ok(await tablet.locator('.detail').evaluate((element) => element.getBoundingClientRect().width < 900))
    assert.equal(await tablet.locator('.workspace').evaluate((element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length), 2)
    await tablet.close()

    await page.setViewportSize({ width: 390, height: 844 })
    await row.click()
    await page.waitForFunction(() => location.hash === '#session/demo')
    assert.equal(await workspace.evaluate((element) => getComputedStyle(element).display), 'none')
    assert.equal(await detail.evaluate((element) => getComputedStyle(element).display), 'block')
    assert.equal(await detail.evaluate((element) => element.getBoundingClientRect().width), 390)
    await page.locator('.back-link').click()
    assert.equal(await workspace.evaluate((element) => getComputedStyle(element).display), 'block')
    await page.goBack()
    await page.waitForFunction(() => location.hash === '#session/demo')
    assert.equal(await page.locator('.app-shell').evaluate((element) => element.classList.contains('mobile-detail')), true)
    await page.goForward()
    await page.waitForFunction(() => location.hash === '#sessions')
    assert.equal(await page.locator('.app-shell').evaluate((element) => element.classList.contains('mobile-detail')), false)
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

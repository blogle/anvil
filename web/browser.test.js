import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'

test('Preact Sessions workspace preserves routing, detail state, factual polling, and responsive layout', async () => {
  const baseSession = { id: 'demo', project: 'Demo', work_branch: 'main', environment_state: 'ready', execution_state: 'idle', created_at: '2026-09-19T11:00:00Z', sandbox: 'sandbox', repository: 'https://example.test/repo', base_ref: 'main' }
  const sessions = [baseSession, ...Array.from({ length: 35 }, (_, index) => ({ ...baseSession, id: `demo-${index}`, project: `Project ${index}`, work_branch: `branch-${index}`, environment_state: index === 2 ? 'suspended' : index === 3 ? 'failed' : 'ready', execution_state: index === 1 ? 'running' : index === 4 ? 'unavailable' : 'idle' }))]
  const selectedState = { environment: 'ready', execution: 'idle', changedAt: new Date(Date.now() - 1000).toISOString(), requestCount: 2 }
  const activityFor = (id) => {
    const session = sessions.find((item) => item.id === id) || baseSession
    const environment = id === 'demo' ? selectedState.environment : session.environment_state
    const execution = id === 'demo' ? selectedState.execution : session.execution_state
    const requestCount = id === 'demo' ? selectedState.requestCount : 1
    return {
      session: { ...session, environment_state: environment, execution_state: execution },
      environment_state: environment,
      execution_state: execution,
      work_state_changed_at: id === 'demo' ? selectedState.changedAt : session.created_at,
      attach_command: `anvilctl sessions attach ${id}`,
      preview_url: 'https://preview.example.test',
      opencode_url: 'https://opencode.example.test',
      lifecycle: id === 'demo'
        ? [{ id: 'created', kind: 'created', at: session.created_at }, { id: 'ready', kind: 'ready', at: '2026-09-19T11:01:00Z', detail: 'Sandbox ready' }, { id: 'run-started', kind: 'run_started', at: '2026-09-19T11:58:30Z' }, { id: 'turn-finished', kind: 'opencode_idle', at: '2026-09-19T12:01:00Z' }]
        : [{ id: 'created', kind: 'created', at: session.created_at }, { id: 'ready', kind: 'ready', at: '2026-09-19T11:01:00Z', detail: 'Sandbox ready' }],
      requests: Array.from({ length: requestCount }, (_, index) => ({ id: `request-${index + 1}`, number: index + 1, origin: 'operator', state: index === 0 ? 'completed' : 'running', started_at: id === 'demo' ? ['2026-09-19T11:58:00Z', '2026-09-19T11:59:00Z', '2026-09-19T12:02:00Z'][index] : session.created_at, completed_at: index === 0 ? '2026-09-19T11:58:20Z' : undefined, last_activity_at: selectedState.changedAt, prompt: index === 0 ? `Representative prompt ${index + 1}: ${'inspect session '.repeat(45)}` : `Follow-up request ${index + 1}` })),
    }
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/__test/change-selected' && request.method === 'POST') {
      selectedState.execution = 'running'
      selectedState.changedAt = new Date().toISOString()
      selectedState.requestCount = 3
      response.writeHead(204); response.end(); return
    }
    if (url.pathname === '/v1/sessions') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(sessions)); return
    }
    const activityMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/activity$/)
    if (activityMatch) {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(activityFor(decodeURIComponent(activityMatch[1])))); return
    }
    const asset = url.pathname === '/' || !url.pathname.startsWith('/assets/') ? 'index.html' : url.pathname.slice(1)
    try {
      const body = await readFile(join(import.meta.dirname, 'dist', asset))
      const type = extname(asset) === '.html' ? 'text/html' : extname(asset) === '.js' ? 'text/javascript' : extname(asset) === '.css' ? 'text/css' : 'application/octet-stream'
      response.writeHead(200, { 'content-type': type }); response.end(body)
    } catch { response.writeHead(404); response.end('not found') }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const executablePath = process.env.CHROMIUM_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim()
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${origin}/#sessions`)
    const workspace = page.locator('.session-workspace'), detail = page.locator('.detail')
    const row = page.locator('[data-session="demo"]')
    await row.waitFor()
    assert.equal(await page.locator('.app-rail [aria-label="Sessions"]').count(), 1)
    assert.equal(await detail.locator('h2').count(), 0, 'landing has useful session content without a detail placeholder')
    assert.equal(await page.getByText('Select a session').count(), 0)
    assert.ok(await workspace.evaluate((element) => element.getBoundingClientRect().width > 900))
    assert.equal(await page.locator('.session-row').count(), sessions.length)
    assert.match(await row.textContent(), /Environment: ready/)
    assert.match(await row.textContent(), /Execution: idle/)
    assert.equal(await row.locator('.session-status-label').count(), 0, 'no semantic WorkState label is rendered')
    await workspace.evaluate((element) => { element.scrollTop = 150 })

    await page.locator('[data-session="demo-1"]').click()
    await page.waitForFunction(() => location.hash === '#session/demo-1')
    assert.equal(await detail.locator('h2').textContent(), 'Project 1 session')
    assert.ok(await detail.evaluate((element) => element.getBoundingClientRect().left > 700), 'desktop selection opens a right drawer')
    await page.goBack(); await page.waitForFunction(() => location.hash === '#sessions')
    await page.goForward(); await page.waitForFunction(() => location.hash === '#session/demo-1')
    await page.locator('#execution-filter').selectOption('idle')
    assert.equal(await detail.locator('.filter-context').isVisible(), true, 'a filtered-out selection remains in its drawer')
    assert.equal(await detail.locator('h2').textContent(), 'Project 1 session')
    assert.equal(await page.locator('[data-session="demo-1"]').count(), 0, 'factual execution filters hide non-matching sessions')
    await workspace.evaluate((element) => { element.scrollTop = 150 })
    await page.locator('.filter-context button').click()
    assert.equal(await page.locator('#execution-filter').inputValue(), '')
    await page.locator('.back-link').click()
    await page.waitForFunction(() => location.hash === '#sessions')
    assert.equal(await workspace.evaluate((element) => element.scrollTop), 150, 'close retains list scroll')
    await page.goBack(); await page.waitForFunction(() => location.hash === '#session/demo-1')
    await page.goForward(); await page.waitForFunction(() => location.hash === '#sessions')

    await row.click()
    await page.waitForFunction(() => location.hash === '#session/demo')
    assert.equal(await detail.locator('h2').textContent(), 'Demo session')
    assert.match(await detail.locator('.factual-state').textContent(), /Environment: ready.*Execution: idle/)
    assert.match(await detail.locator('#logs-panel').textContent(), /Lifecycle & requests/)
    assert.match(await detail.locator('#runtime-panel').textContent(), /Runtime details/)
    const timeline = detail.locator('.timeline > .timeline-event')
    assert.deepEqual(await timeline.evaluateAll((entries) => entries.map((entry) => entry.dataset.timelineItem === 'request' ? `request:${entry.dataset.requestNumber}` : `event:${entry.dataset.eventKind}`)), [
      'event:created', 'event:ready', 'request:1', 'event:run_started', 'request:2', 'event:opencode_idle',
    ])
    assert.deepEqual(await timeline.evaluateAll((entries) => entries.map((entry) => entry.querySelectorAll('.event-marker').length)), [1, 1, 1, 1, 1, 1])
    assert.equal(await timeline.locator('.request-card').count(), 2)
    assert.equal(await timeline.locator('.request-card').first().evaluate((card) => getComputedStyle(card, '::before').content), 'none')
    await page.locator('.attach summary').click()
    const prompt = detail.locator('.prompt').first()
    const promptToggle = page.locator('.prompt-toggle')
    await promptToggle.scrollIntoViewIfNeeded(); await promptToggle.click()
    await page.locator('#runtime-tab').click(); await page.locator('#runtime-tab').focus()
    const detailScroll = await detail.evaluate((element) => { element.querySelector('.detail-inner').style.minHeight = '1400px'; element.scrollTop = 120; return element.scrollTop })
    assert.equal(detailScroll, 120)
    await page.evaluate(() => {
      window.initialNodes = { row: document.querySelector('[data-session="demo"]'), detail: document.querySelector('.detail'), shell: document.querySelector('.detail-inner'), header: document.querySelector('.detail-header'), factual: document.querySelector('.detail .factual-state'), actions: document.querySelector('.actions'), tabs: document.querySelector('.tabs'), logs: document.querySelector('#logs-panel'), runtime: document.querySelector('#runtime-panel'), focus: document.activeElement }
      window.noOpMutations = []
      window.noOpObserver = new MutationObserver((records) => window.noOpMutations.push(...records))
      window.noOpObserver.observe(window.initialNodes.row, { subtree: true, childList: true, characterData: true, attributes: true })
    })
    const noOpResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/sessions/demo/activity')
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await (await noOpResponse).finished()
    const noOpMutations = await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      window.noOpMutations.push(...window.noOpObserver.takeRecords())
      window.noOpObserver.disconnect()
      return window.noOpMutations.map(({ type, target }) => `${type}:${target.nodeName}`)
    })
    assert.deepEqual(noOpMutations, [], 'no-op refresh produces no DOM mutations')
    assert.equal(await row.evaluate((element) => element === window.initialNodes.row), true)
    await page.evaluate("fetch('/__test/change-selected', {method:'POST'})")
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.waitForFunction(() => document.querySelector('.detail .factual-state')?.textContent.includes('Execution: running'))
    assert.match(await detail.locator('.factual-state').textContent(), /Execution: running/)
    for (const [selector, key] of [['[data-session="demo"]', 'row'], ['.detail', 'detail'], ['.detail-inner', 'shell'], ['.detail-header', 'header'], ['.detail .factual-state', 'factual'], ['.actions', 'actions'], ['.tabs', 'tabs'], ['#logs-panel', 'logs'], ['#runtime-panel', 'runtime']]) {
      assert.equal(await page.locator(selector).evaluate((element, name) => element === window.initialNodes[name], key), true, `${selector} remains mounted across selected factual updates`)
    }
    assert.equal(await row.locator('.session-status-label').count(), 0)
    assert.equal(await detail.locator('text=Work state').count(), 0)
    assert.equal(await page.locator('#runtime-tab').evaluate((element) => element === document.activeElement), true)
    assert.equal(await page.locator('#runtime-tab').getAttribute('aria-selected'), 'true')
    assert.equal(await detail.evaluate((element) => element.scrollTop), detailScroll)
    assert.equal(await detail.locator('details').evaluate((element) => element.open), true)
    assert.equal(await prompt.evaluate((element) => element.classList.contains('expanded')), true)

    await page.locator('.back-link').click(); await page.waitForFunction(() => location.hash === '#sessions')
    await page.goBack(); await page.waitForFunction(() => location.hash === '#session/demo')
    await page.goForward(); await page.waitForFunction(() => location.hash === '#sessions')
    const direct = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await direct.goto(`${origin}/#session/demo`)
    await direct.locator('[data-session-detail] h2').waitFor({ state: 'attached' })
    assert.equal(await direct.locator('.detail h2').textContent(), 'Demo session', 'direct links open the drawer')
    await direct.close()

    const tablet = await browser.newPage({ viewport: { width: 900, height: 900 } })
    await tablet.goto(`${origin}/#session/demo`)
    await tablet.locator('[data-session-detail] h2').waitFor({ state: 'attached' })
    assert.ok(await tablet.locator('.detail').evaluate((element) => element.getBoundingClientRect().width < 900))
    await tablet.close()
    await page.setViewportSize({ width: 390, height: 844 })
    await row.click()
    await page.waitForFunction(() => location.hash === '#session/demo')
    assert.equal(await workspace.evaluate((element) => getComputedStyle(element).display), 'none')
    assert.equal(await detail.evaluate((element) => getComputedStyle(element).display), 'block')
    assert.equal(await detail.evaluate((element) => element.getBoundingClientRect().width), 390)
    await page.locator('.back-link').click()
    assert.equal(await workspace.evaluate((element) => getComputedStyle(element).display), 'block')
    await page.goBack(); await page.waitForFunction(() => location.hash === '#session/demo')
    assert.equal(await page.locator('.app-shell').evaluate((element) => element.classList.contains('mobile-detail')), true)
    await page.goForward(); await page.waitForFunction(() => location.hash === '#sessions')
    assert.equal(await page.locator('.app-shell').evaluate((element) => element.classList.contains('mobile-detail')), false)
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

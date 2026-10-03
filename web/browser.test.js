import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'

test('production browser retains sessions, detail interactions, routes, and mobile layout', async () => {
  const session = { id: 'demo', project: 'Demo', work_branch: 'main', environment_state: 'ready', work_state: 'in_progress', created_at: '2026-09-19T11:00:00Z', sandbox: 'sandbox', repository: 'https://example.test/repo', base_ref: 'main' }
  const state = { summary: `Initial metadata ${'long summary '.repeat(500)}`, execution: 'running', request: 'running', project: session.project, branch: session.work_branch, changedAt: new Date(Date.now() - 1000).toISOString() }
  const currentSession = () => ({ ...session, project: state.project, work_branch: state.branch })
  const activity = () => ({ session: currentSession(), environment_state: 'ready', execution_state: state.execution, request_state: state.request, work_state: 'in_progress', work_state_changed_at: state.changedAt, work_state_summary: state.summary, attach_command: 'anvilctl sessions attach demo', lifecycle: [{ kind: 'created', at: '2026-09-19T11:00:00Z' }], requests: [{ id: 'request-1', number: 1, origin: 'operator', state: state.request, started_at: '2026-09-19T11:58:00Z', last_activity_at: '2026-09-19T11:59:00Z', prompt: `selection anchor ${'long prompt '.repeat(500)}` }] })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/v1/sessions') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify([currentSession()])); return
    }
    if (url.pathname === '/v1/sessions/demo/activity') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(activity())); return
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`http://127.0.0.1:${server.address().port}/#session/demo`)
    const row = page.locator('[data-session="demo"]')
    await row.waitFor()
    await page.locator('.work-summary').waitFor()
    assert.equal(await page.locator('.session-status-label').count(), 1)
    const initialElapsed = await row.locator('.row-detail').textContent()
    await page.evaluate(() => {
      window.initialRow = document.querySelector('[data-session="demo"]')
      window.initialDetail = document.querySelector('.detail')
      window.initialActions = document.querySelector('.actions')
      window.initialTab = document.querySelector('#logs-tab')
      const elapsed = window.initialRow.querySelector('.row-detail')
      window.elapsedText = [...elapsed.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim())
    })

    const noOpMutations = await page.evaluate(async () => {
      const row = document.querySelector('[data-session="demo"]')
      const records = []
      const observer = new MutationObserver((mutations) => records.push(...mutations))
      observer.observe(row, { subtree: true, childList: true, characterData: true, attributes: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise((resolve) => setTimeout(resolve, 100))
      observer.disconnect()
      return records.map(({ type, target }) => `${type}:${target.nodeName}`)
    })
    assert.deepEqual(noOpMutations, [])
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.waitForTimeout(100)
    assert.equal(await row.evaluate((element) => element === window.initialRow), true)

    state.summary = `Updated metadata ${'long summary '.repeat(500)}`
    state.project = 'Updated Demo'
    state.branch = 'feature/live-refresh'
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.getByText('Updated metadata').waitFor()
    assert.equal(await row.evaluate((element) => element === window.initialRow), true)
    assert.equal(await row.locator('.session-meta').locator('span').first().textContent(), 'Updated Demo')
    assert.equal(await row.locator('.session-meta code').textContent(), 'feature/live-refresh')
    await page.waitForTimeout(1100)
    assert.equal(await row.evaluate((element) => element === window.initialRow), true)
    assert.notEqual(await row.locator('.row-detail').textContent(), initialElapsed)
    assert.equal(await row.locator('.row-detail').evaluate((element) => [...element.childNodes].includes(window.elapsedText)), true)

    const detail = page.locator('.detail'), actions = page.locator('.actions'), runtimeTab = page.locator('#runtime-tab')
    await detail.evaluate((element) => { element.style.height = '300px'; element.style.overflow = 'auto' })
    await detail.evaluate((element) => { element.scrollTop = 80 })
    await page.locator('.attach summary').click()
    const promptToggle = page.locator('.prompt-toggle')
    await promptToggle.scrollIntoViewIfNeeded()
    await promptToggle.click()
    const prompt = page.locator('.prompt')
    await detail.evaluate((element) => { element.scrollTop = 80 })
    assert.ok(await detail.evaluate((element) => element.scrollHeight - element.clientHeight >= 80))
    assert.equal(await detail.evaluate((element) => element.scrollTop), 80)
    state.execution = 'idle'
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.getByText('Working', { exact: true }).first().waitFor()
    assert.equal(await row.evaluate((element) => element === window.initialRow), true)
    state.request = 'completed'
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.getByText('Ready for review', { exact: true }).first().waitFor()
    assert.equal(await row.evaluate((element) => element === window.initialRow), true)
    assert.equal(await detail.count(), 1)
    assert.equal(await actions.count(), 1)
    assert.equal(await detail.evaluate((element) => element === window.initialDetail), true)
    assert.equal(await actions.evaluate((element) => element === window.initialActions), true)
    assert.equal(await page.locator('#logs-tab').evaluate((element) => element === window.initialTab), true)
    assert.equal(await page.locator('details').evaluate((element) => element.open), true)
    assert.equal(await prompt.evaluate((element) => element.classList.contains('expanded')), true)
    assert.equal(await detail.evaluate((element) => element.scrollTop), 80)
    assert.equal(await row.getAttribute('aria-current'), 'true')

    await runtimeTab.evaluate((element) => element.click())
    await runtimeTab.focus()
    state.summary = `Routine refresh metadata ${'long summary '.repeat(500)}`
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.getByText('Routine refresh metadata').waitFor()
    assert.equal(await runtimeTab.evaluate((element) => element === document.activeElement), true)
    assert.equal(await page.locator('#runtime-panel').isVisible(), true)

    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.locator('.sidebar').evaluate((element) => getComputedStyle(element).display), 'none')
    assert.equal(await detail.evaluate((element) => getComputedStyle(element).display), 'block')
    await page.locator('.back-link').click()
    assert.equal(await page.locator('.sidebar').evaluate((element) => getComputedStyle(element).display), 'block')
    await page.goBack()
    await page.waitForFunction(() => location.hash === '#session/demo')
    assert.equal(await page.locator('.app-shell').evaluate((element) => element.classList.contains('mobile-detail')), true)
    await page.goForward()
    await page.waitForFunction(() => location.hash === '')
    assert.equal(await page.locator('.app-shell').evaluate((element) => element.classList.contains('mobile-detail')), false)
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

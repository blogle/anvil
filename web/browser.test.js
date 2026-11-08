import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'

test('static workspace routes render and campaign contract validation is usable', async t => {
  const root = join(import.meta.dirname, 'out')
  let campaignSubmissions = 0
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (req.method === 'POST' && path === '/v1/campaigns') {
      campaignSubmissions++
      const status = campaignSubmissions === 1 ? 503 : 422
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: status === 503 ? 'service unavailable' : 'invalid campaign' })); return
    }
    if (path === '/v1/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify([{ id: 'safe/?#id', project: 'Fixture session', environment_state: 'ready', execution_state: 'idle' }, { id: 'other', project: 'Failed activity fixture' }])); return
    }
    if (path === '/v1/sessions/safe%2F%3F%23id/activity') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ session: { opencode_session_id: 'ses/safe?#id' }, opencode_url: 'https://opencode.example.test/path', preview_url: 'javascript:alert(1)', attach_command: 'anvilctl sessions attach safe/?#id', events: [{ id: 'fixture-event', kind: 'message', title: 'Agent', detail: 'Fixture conversation' }] })); return
    }
    if (path === '/v1/sessions/other/activity') {
      res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'activity unavailable' })); return
    }
    const safe = normalize(decodeURIComponent(path)).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '')
    if (safe.split(sep).includes('..')) { res.writeHead(404); res.end('not found'); return }
    const asset = join(root, safe, path.endsWith('/') || !extname(path) ? 'index.html' : '')
    try {
      const body = await readFile(asset)
      const ext = extname(asset)
      res.writeHead(200, { 'content-type': ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream' }); res.end(body)
    } catch { res.writeHead(404); res.end('not found') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    const executablePath = process.env.CHROMIUM_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim()
    browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.getByRole('heading', { name: /Make work legible/ }).waitFor()
    await page.getByRole('link', { name: /Create a Campaign/ }).click()
    await page.getByRole('heading', { name: /Create a Campaign/ }).waitFor()
    await page.locator('#submission').fill('{"campaign":{"purpose":""},"commissions":[]}')
    await page.getByRole('button', { name: /Submit Campaign/ }).click()
    await page.locator('.notice.error').waitFor()
    assert.match(await page.locator('.notice.error').textContent(), /purpose is required/)
    await page.locator('#submission').fill(JSON.stringify({ campaign: { purpose: 'Browser test campaign', shared_contracts: [] }, commissions: [{
      local_key: 'one', objective: 'Browser test', obligations: [{ id: 'test', version: 1, requirement: 'Works', acceptance_expectations: ['Works'] }],
    }] }))
    const resetCampaign = page.getByRole('button', { name: 'Reset rejected request' })
    assert.equal(await resetCampaign.isDisabled(), true, 'must not reset before a definitive rejection')
    await page.getByRole('button', { name: /Submit Campaign/ }).click()
    await page.getByRole('alert').filter({ hasText: 'outcome is uncertain' }).waitFor()
    assert.equal(await resetCampaign.isDisabled(), true, '5xx does not make reset safe')
    assert.match(await page.locator('.form-footer').textContent(), /retained for retry/)
    await page.getByRole('button', { name: /Submit Campaign/ }).click()
    await page.getByRole('alert').filter({ hasText: 'server rejected this request' }).waitFor()
    assert.equal(await resetCampaign.isDisabled(), false, 'definitive 4xx rejection permits reset')
    await resetCampaign.click()
    assert.match(await page.locator('.form-footer').textContent(), /created and retained until accepted/)
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.locator('.content').evaluate(el => el.getBoundingClientRect().width <= 390))
    await page.goto(`http://127.0.0.1:${server.address().port}/sessions/`)
    await page.getByRole('link', { name: /Fixture session/ }).click()
    await page.locator('[data-opencode-link]').waitFor()
    const serverKey = btoa('https://opencode.example.test/path').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    assert.equal(await page.locator('[data-opencode-link]').getAttribute('href'), `https://opencode.example.test/server/${serverKey}/session/ses%2Fsafe%3F%23id`)
    assert.equal(await page.getByRole('link', { name: 'Open Preview' }).count(), 0, 'unsafe preview schemes are not rendered')
    assert.match(await page.locator('.attach').textContent(), /anvilctl sessions attach safe\/?\?#id/)
    await page.locator('[data-event-id="fixture-event"]').waitFor()
    await page.getByRole('link', { name: /Failed activity fixture/ }).click()
    await page.getByRole('alert').filter({ hasText: 'activity unavailable' }).waitFor()
    assert.equal(await page.locator('[data-opencode-link]').count(), 0, 'failed detail fetch does not retain the previous session link')
    assert.equal(await page.locator('[data-event-id="fixture-event"]').count(), 0, 'failed detail fetch does not retain previous activity')
    await page.goto(`http://127.0.0.1:${server.address().port}/sessions?id=missing`)
    await page.getByRole('heading', { name: 'Session unavailable' }).waitFor()
    assert.match(await page.locator('section.data-card').textContent(), /not present in the current session list/)
    for (const route of ['/campaign/', '/commission/', '/sessions/']) {
      const response = await page.request.get(`http://127.0.0.1:${server.address().port}${route}`)
      assert.equal(response.status(), 200)
    }
    const routeWithoutSlash = await page.request.get(`http://127.0.0.1:${server.address().port}/sessions`)
    assert.equal(routeWithoutSlash.status(), 200, 'non-slash static route resolves to its exported index')
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
})

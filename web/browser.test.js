import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'

test('static workspace routes render and campaign contract validation is usable', async t => {
  const root = join(import.meta.dirname, 'out')
  let campaignSubmissions = 0, inboxCalls = 0, decisionCalls = 0
  const decisionCursors = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname
    if (path === '/v1/inbox') {
      inboxCalls++
      const item = (commission_id, local_key, overrides = {}) => ({ campaign_id: 'campaign/1', commission_id, local_key, objective: `Work ${local_key}`, commission: { state: 'active', version: 2, start_authorized: true }, task: { state: 'running', controller_mode: 'automatic', operator_hold: false, hold_reason: null, retry_due_ms: null }, start_after: [], integration_after: [], attempt: { attempt_id: 'attempt-1', ordinal: 1, state: 'running', failure_reason: null, session_id: 'session/1' }, ...overrides })
      const first = item('commission/1', 'held', { task: { state: 'paused', controller_mode: 'operator', operator_hold: true, hold_reason: 'Review requested', retry_due_ms: 1234 }, attempt: null })
      const second = item('commission/2', 'normal', { commission: { state: 'draft', version: 1, start_authorized: false } })
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ schema_version: 1, items: url.searchParams.has('after') ? [second] : [first], next_cursor: url.searchParams.has('after') ? null : 'page-2' })); return
    }
    if (req.method === 'POST' && path === '/v1/campaigns') {
      campaignSubmissions++
      const status = campaignSubmissions === 1 ? 503 : 422
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: status === 503 ? 'service unavailable' : 'invalid campaign' })); return
    }
    if (path === '/v1/commissions/decision-task') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ campaign_id: 'campaign/1', local_key: 'history', objective: 'History fixture', version: 1, state: 'active', start_authorized: true, obligations: [], execution_target: {} })); return
    }
    if (path === '/v1/tasks/decision-task/decisions') {
      decisionCalls++
      decisionCursors.push(url.searchParams.get('cursor'))
      const first = { decision_sequence: 1, rule_id: 'no_progress', logical_time_ms: 1234, authorization_blocked_reason: 'shadow_mode', canonical_actions_json: [{ kind: 'observe', content: 'fixture-secret-prompt' }] }
      const second = { decision_sequence: 2, rule_id: 'retry', logical_time_ms: 2345, authorization_blocked_reason: null, canonical_actions_json: [{ kind: 'retry' }] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(url.searchParams.has('cursor') ? { decisions: [second], next_cursor: null } : { decisions: [first], next_cursor: 987654 })); return
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
    await page.getByRole('heading', { name: 'Inbox' }).waitFor()
    assert.match(await page.locator('.crumb').textContent(), /Workspace\s*\/\s*Inbox/, 'home breadcrumb matches the Inbox navigation label')
    await page.getByText('Operator hold: Review requested').waitFor()
    assert.match(await page.locator('.inbox-note').textContent(), /not an assessment of scheduler readiness/)
    assert.match(await page.locator('.inbox-panel').textContent(), /No attempt recorded/)
    assert.equal(inboxCalls, 1, 'first page loads without fetching all pages')
    await page.getByRole('button', { name: 'Everything' }).click()
    await page.getByRole('button', { name: 'Load 20 more' }).click()
    await page.getByText('Work normal').waitFor()
    assert.equal(inboxCalls, 2, 'next page is fetched only after explicit request')
    await page.getByRole('button', { name: 'Focused' }).click()
    await page.getByText('Commission v1 · Start not authorized').waitFor()
    assert.match(await page.locator('.inbox-panel').textContent(), /Start not authorized/)
    assert.equal(await page.locator('.inbox-links a').count(), 5, 'campaign, commission, and latest-attempt session links are present')
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
    await page.goto(`http://127.0.0.1:${server.address().port}/commission?id=decision-task`)
    await page.getByRole('heading', { name: 'History fixture' }).waitFor()
    await page.getByText('Decision 1').waitFor()
    assert.match(await page.locator('.decision-history').textContent(), /no_progress.*Historical rule result/s)
    assert.match(await page.locator('.decision-history').textContent(), /not a live watchdog/)
    assert.match(await page.locator('.decision-history').textContent(), /Authorization blocked reason[\s\S]*shadow_mode/)
    assert.match(await page.locator('.decision-history').textContent(), /Proposed actions: 1/)
    assert.doesNotMatch(await page.locator('.decision-history').textContent(), /fixture-secret-prompt/)
    assert.match(await page.locator('.decision-history').textContent(), /no latest decision is asserted until every page has been fetched/)
    assert.equal(decisionCalls, 1, 'only the first history page is fetched automatically')
    await page.getByRole('button', { name: 'Load next decision page' }).click()
    await page.getByText('Decision 2').waitFor()
    assert.equal(decisionCalls, 2, 'the next history page is fetched only on request')
    assert.deepEqual(decisionCursors, [null, '987654'], 'the next page uses the returned global cursor, not decision_sequence')
    assert.match(await page.locator('.decision-history').textContent(), /Logical time \(ms\)[\s\S]*1234[\s\S]*2345/)
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

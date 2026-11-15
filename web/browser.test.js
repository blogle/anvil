import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

test('live-matched workbench shell uses returned records and exposes unavailable data honestly', async t => {
  const root = join(import.meta.dirname, 'out')
  const screenshotDir = '/tmp/opencode'
  await mkdir(screenshotDir, { recursive: true })
  const calls = []
  const campaignKeys = [], credentialAuth = [], oauthAuth = []
  let createAttempts = 0, startAttempts = 0, oauthPolls = 0
  const startKeys = [], startVersions = []
  const inbox = {
    schema_version: 1,
    items: [
      { campaign_id: 'campaign-fixture-1', commission_id: 'commission-focus-1', local_key: 'first-focused', objective: 'First recorded focus item', commission: { state: 'active', version: 3, start_authorized: false, obligations: [{ id: 'required', version: 1, requirement: 'Retain the work contract', acceptance_expectations: ['Contract remains visible'] }], execution_target: { kind: 'git_repository', repository: 'https://example.invalid/repo' } }, task: { state: 'paused', controller_mode: 'operator', operator_hold: true, hold_reason: 'Operator review', repository: 'fixture-repo' }, start_after: [], integration_after: [], attempt: { attempt_id: 'attempt-fixture-1', ordinal: 1, state: 'failed', session_id: 'session-fixture-1', failure_reason: 'fixture failure' } },
      { campaign_id: 'campaign-fixture-1', commission_id: 'commission-second', local_key: 'second', objective: 'Second Commission', commission: { state: 'draft', version: 1, start_authorized: false, obligations: [] }, task: { state: 'queued', controller_mode: 'automatic', operator_hold: false }, start_after: [], integration_after: [], attempt: null },
    ],
    next_cursor: null,
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString()
    calls.push({ method: req.method, path, auth: req.headers.authorization, body: rawBody })
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (path === '/v1/inbox') return json(200, inbox)
    if (path === '/v1/sessions') return json(200, [{ id: 'session-fixture-1', project: 'Fixture session', environment_state: 'ready', execution_state: 'idle' }])
    if (path === '/v1/capacity') return json(200, { running: 2, provisioning: 1, global_limit: 8, available_slots: 5, queued_runnable: 3 })
    if (path === '/v1/commissions/commission-focus-1') return json(200, { campaign_id: 'campaign-fixture-1', commission_id: 'commission-focus-1', objective: 'First recorded focus item', state: 'active', version: 3, start_authorized: false, obligations: [{ id: 'required', version: 1, requirement: 'Retain the work contract', acceptance_expectations: ['Contract remains visible'] }], execution_target: { kind: 'git_repository' } })
    if (path === '/v1/commissions/commission-focus-1/start' && req.method === 'POST') {
      startAttempts++; startKeys.push(req.headers['idempotency-key'])
      const body = JSON.parse(rawBody); startVersions.push(body.expected_version)
      assert.equal(body.expected_version, 3)
      assert.ok(req.headers['idempotency-key'], 'Commission start requires an idempotency key')
      if (startAttempts === 1) return json(503, { message: 'temporary fixture outage' })
      return json(202, { commission_id: 'commission-focus-1', state: 'accepted', expected_version: 3 })
    }
    if (path === '/v1/tasks/commission-focus-1/attempts') return json(200, { attempts: [{ attempt_id: 'attempt-fixture-1', ordinal: 1, state: 'failed', session_id: 'session-fixture-1' }] })
    if (path === '/v1/sessions/session-fixture-1/activity' || path === '/v1/sessions/session-fixture-1/diff') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ message: 'Unavailable in fixture' })) }
    if (path === '/v1/campaigns/campaign-fixture-1' && req.method === 'GET') return json(200, { campaign: { purpose: 'Fixture campaign purpose', shared_contracts: [] }, commissions: [{ commission_id: 'commission-focus-1', objective: 'First recorded focus item', start_after: [], integration_after: [] }] })
    if (path === '/v1/campaigns' && req.method === 'POST') {
      createAttempts++; campaignKeys.push(req.headers['idempotency-key'])
      if (createAttempts === 1) return json(503, { message: 'temporary fixture outage' })
      return json(201, { campaign_id: 'campaign-created-fixture' })
    }
    if (path === '/v1/provider-credentials' && req.method === 'GET') {
      credentialAuth.push(req.headers.authorization)
      return json(200, [{ provider_id: 'fixture-provider', generation: 2, created_at: '2026-10-01T00:00:00Z', kind: 'oauth' }])
    }
    if (path === '/v1/provider-credentials/catalog' && req.method === 'GET') {
      credentialAuth.push(req.headers.authorization)
      // Mirror the backend's safe projection: unsupported entries and their secret-like fields are omitted.
      return json(200, [
        { id: 'fixture-provider', name: 'Fixture Provider' },
        { id: 'openai', name: 'OpenAI' },
        { id: 'opencode-go', name: 'OpenCode Go' },
      ])
    }
    if (path === '/v1/provider-credentials/fixture-provider/methods') {
      oauthAuth.push(req.headers.authorization)
      return json(200, { methods: [
        { id: 'fixture-auto', label: 'Fixture automatic sign-in' },
        { id: 'fixture-code', label: 'Fixture code sign-in' },
        { id: 'fixture-form', label: 'Fixture form sign-in', form: [
          { key: 'account', type: 'string', title: 'Fixture account', required: true },
          { key: 'remember', type: 'boolean', title: 'Remember fixture account' },
        ] },
      ] })
    }
    if (path === '/v1/provider-credentials/fixture-provider/oauth' && req.method === 'POST') {
      oauthAuth.push(req.headers.authorization)
      const body = JSON.parse(rawBody)
      const id = body.method_id === 'fixture-auto' ? 'login-auto-fixture' : body.method_id === 'fixture-code' ? 'login-code-fixture' : 'login-fixture-form-fixture'
      if (body.method_id === 'fixture-form') assert.deepEqual(body.answer, { account: 'synthetic-form-secret-DO-NOT-STORE', remember: true })
      else assert.equal(Object.hasOwn(body, 'answer'), false, 'zero-form OAuth request omits answer')
      const mode = body.method_id === 'fixture-code' ? 'code' : 'auto'
      return json(200, { login_id: id, mode, time: { expires: Date.now() + 60000 }, url: 'https://provider.example.invalid/sign-in', instructions: 'Fixture only: complete provider sign-in.' })
    }
    if (path === '/v1/provider-credentials/fixture-provider/oauth/login-auto-fixture') {
      oauthAuth.push(req.headers.authorization); oauthPolls++
      return json(200, { status: 'complete' })
    }
    if (path === '/v1/provider-credentials/fixture-provider/oauth/login-fixture-form-fixture') {
      oauthAuth.push(req.headers.authorization); oauthPolls++
      return json(200, { status: 'complete' })
    }
    if (path === '/v1/provider-credentials/fixture-provider/oauth/login-code-fixture/complete' && req.method === 'POST') {
      oauthAuth.push(req.headers.authorization)
      assert.deepEqual(JSON.parse(rawBody), { code: 'synthetic-code-DO-NOT-STORE' })
      return json(204, null)
    }
    if (path === '/v1/provider-credentials/fixture-provider/oauth/login-code-fixture') {
      oauthAuth.push(req.headers.authorization)
      return json(200, { status: 'complete' })
    }
    const safe = normalize(decodeURIComponent(path)).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '')
    if (safe.split(sep).includes('..')) { res.writeHead(404); return res.end('not found') }
    const asset = join(root, safe, path.endsWith('/') || !extname(path) ? 'index.html' : '')
    try {
      const body = await readFile(asset), ext = extname(asset)
      res.writeHead(200, { 'content-type': ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream' }); res.end(body)
    } catch { res.writeHead(404); res.end('not found') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    const executablePath = process.env.CHROMIUM_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim()
    browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
    const base = `http://127.0.0.1:${server.address().port}`
    await page.goto(base)
    await page.getByRole('heading', { name: 'Inbox' }).waitFor()
    await page.getByText('First recorded focus item').first().waitFor()
    const nav = page.getByRole('navigation', { name: 'Primary application areas' })
    assert.equal(await nav.getByRole('link').count(), 4)
    for (const label of ['Inbox', 'Campaigns', 'Operations', 'Settings']) assert.equal(await nav.getByRole('link', { name: label }).count(), 1, `${label} is an exact accessible navigation label`)
    const colors = await page.evaluate(() => ({ app: getComputedStyle(document.querySelector('.anvil-app')).backgroundColor, panel: getComputedStyle(document.querySelector('.primary-view')).backgroundColor }))
    assert.equal(colors.app, 'rgb(33, 28, 24)')
    assert.equal(colors.panel, 'rgb(40, 35, 30)')
    assert.equal(await page.locator('.area-nav').evaluate(el => Math.round(el.getBoundingClientRect().width)), 184)
    assert.equal(await page.locator('.inspector').evaluate(el => Math.round(el.getBoundingClientRect().width)), 390)
    assert.equal(await page.locator('.commission-row[aria-current="true"]').innerText().then(text => text.includes('First recorded focus item')), true, 'first returned recorded focus item is selected by default')
    await page.screenshot({ path: `${screenshotDir}/anvil-workbench-desktop-inbox.png`, fullPage: true })
    const tabs = page.getByRole('tablist', { name: 'Commission details' }).getByRole('tab')
    assert.deepEqual(await tabs.allTextContents(), ['Overview', 'Obligations', 'Diff', 'Activity', 'Attempts'])
    await tabs.nth(0).click()
    assert.equal(startAttempts, 0, 'no Commission start is sent before an explicit click')
    await page.getByRole('button', { name: 'Start Commission' }).click()
    await page.locator('.mock-actions [role="alert"]').filter({ hasText: 'outcome is uncertain' }).waitFor()
    assert.equal(startAttempts, 1)
    await page.getByRole('button', { name: 'Start Commission' }).click()
    await page.locator('.inspector-title').filter({ hasText: 'First recorded focus item' }).waitFor()
    assert.equal(startAttempts, 2, 'exactly two explicit start requests are issued for the retry')
    assert.ok(startKeys[0] && startKeys[0] === startKeys[1], 'uncertain Commission start retry retains the same idempotency key')
    assert.deepEqual(startVersions, [3, 3])
    assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/v1/commissions/commission-focus-1/start').length, 2, 'there are no unsolicited Commission starts')
    await tabs.nth(2).click()
    await page.getByRole('alert').filter({ hasText: 'Could not load diff' }).waitFor()
    assert.match(await page.locator('[role="tabpanel"]').innerText(), /Could not load diff/)
    await page.screenshot({ path: `${screenshotDir}/anvil-workbench-selected-inspector.png`, fullPage: true })
    await tabs.nth(3).click()
    await page.getByRole('alert').filter({ hasText: 'Could not load activity' }).waitFor()
    await page.getByRole('navigation', { name: 'Primary application areas' }).getByRole('link', { name: 'Campaigns' }).click()
    await page.getByRole('heading', { name: 'Create Campaign' }).waitFor()
    await page.getByRole('button', { name: 'campaign-fixture-1' }).click()
    await page.getByText('Fixture campaign purpose').waitFor()
    await page.getByRole('button', { name: /Submit Campaign/ }).click()
    await page.getByRole('alert').filter({ hasText: 'outcome is uncertain' }).waitFor()
    await page.getByRole('button', { name: /Submit Campaign/ }).click()
    await page.locator('.inspector-title').filter({ hasText: 'campaign-created-fixture' }).first().waitFor()
    assert.equal(campaignKeys.length, 2)
    assert.ok(campaignKeys[0] && campaignKeys[0] === campaignKeys[1], 'uncertain retry retains the same idempotency key')
    await page.getByRole('navigation', { name: 'Primary application areas' }).getByRole('link', { name: 'Operations' }).click()
    await page.getByRole('heading', { name: 'Operations' }).waitFor()
    const opsTabs = page.getByRole('tablist', { name: 'Operations views' }).getByRole('tab')
    assert.deepEqual(await opsTabs.allTextContents(), ['Fleet', 'Performance', 'Budget'])
    await page.getByText('2', { exact: true }).first().waitFor()
    await opsTabs.nth(1).click()
    assert.match(await page.locator('.workbench-operations').innerText(), /Unavailable/)
    await opsTabs.nth(2).click()
    assert.match(await page.locator('.workbench-operations').innerText(), /Spend and quota are unavailable/)
    await page.screenshot({ path: `${screenshotDir}/anvil-workbench-operations.png`, fullPage: true })
    await page.getByRole('navigation', { name: 'Primary application areas' }).getByRole('link', { name: 'Settings' }).click()
    await page.getByRole('heading', { name: 'Provider credentials' }).waitFor()
    await page.screenshot({ path: `${screenshotDir}/anvil-workbench-settings.png`, fullPage: true })
    const operatorToken = 'synthetic-operator-token-DO-NOT-STORE'
    await page.locator('#operator-token').fill(operatorToken)
    await page.getByRole('button', { name: 'Browse providers' }).click()
    await page.getByLabel('Search providers').waitFor()
    const providerSearch = page.getByLabel('Search providers')
    const providerCatalog = page.locator('#provider-catalog-select')
    await providerSearch.fill('Fixture Provider')
    assert.deepEqual(await providerCatalog.locator('option').allTextContents(), ['Choose a provider', 'Fixture Provider (fixture-provider)'], 'catalog search matches provider names')
    await providerCatalog.selectOption('fixture-provider')
    assert.equal(await page.locator('#provider-id').inputValue(), 'fixture-provider', 'catalog selection sets the provider field')
    await providerSearch.fill('opencode-go')
    assert.deepEqual(await providerCatalog.locator('option').allTextContents(), ['Choose a provider', 'OpenCode Go (opencode-go)'], 'catalog search matches provider IDs')
    await providerCatalog.selectOption('opencode-go')
    assert.equal(await page.locator('#provider-id').inputValue(), 'opencode-go')
    assert.doesNotMatch(await page.locator('body').innerText(), /unsupported-provider|catalog-secret|private-key-material/)
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0], 'provider selection does not persist credentials or tokens')
    await page.locator('#provider-id').fill('fixture-provider')
    await page.getByRole('button', { name: 'Load credential metadata' }).click()
    await page.getByText('Generation 2').waitFor()
    await page.locator('#provider-id').fill('fixture-provider')
    await page.getByRole('button', { name: 'Load methods' }).click()
    await page.locator('#oauth-method').waitFor({ state: 'visible' })
    await page.waitForFunction(() => !document.querySelector('#oauth-method').disabled)
    await page.getByLabel('Sign-in method').selectOption('fixture-auto')
    await page.getByRole('button', { name: 'Start OAuth sign-in' }).click()
    await page.getByText('Sign-in complete.').waitFor({ timeout: 5000 })
    await page.getByLabel('Sign-in method').selectOption('fixture-form')
    await page.getByRole('button', { name: 'Start OAuth sign-in' }).click()
    await page.getByRole('alert').filter({ hasText: 'Complete the required field: Fixture account.' }).waitFor()
    assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/v1/provider-credentials/fixture-provider/oauth').length, 1, 'missing required form answer blocks POST')
    await page.getByRole('textbox', { name: 'Fixture account', exact: true }).fill('synthetic-form-secret-DO-NOT-STORE')
    await page.getByLabel('Remember fixture account').check()
    await page.getByRole('button', { name: 'Start OAuth sign-in' }).click()
    await page.getByText('Sign-in complete.').waitFor({ timeout: 5000 })
    assert.doesNotMatch(await page.locator('body').innerText(), /synthetic-form-secret-DO-NOT-STORE/)
    assert.ok(oauthPolls > 0, 'automatic OAuth mode polls status with GET')
    await page.getByLabel('Sign-in method').selectOption('fixture-code')
    await page.getByRole('button', { name: 'Start OAuth sign-in' }).click()
    await page.getByLabel('Paste sign-in code').fill('synthetic-code-DO-NOT-STORE')
    await page.getByRole('button', { name: 'Complete sign-in' }).click()
    await page.getByText('Sign-in complete.').waitFor({ timeout: 5000 })
    assert.ok(credentialAuth.every(value => value === `Bearer ${operatorToken}`))
    assert.ok(oauthAuth.length && oauthAuth.every(value => value === `Bearer ${operatorToken}`))
    const secretsInPage = await page.locator('body').innerText()
    assert.doesNotMatch(secretsInPage, /synthetic-operator-token|synthetic-code-DO-NOT-STORE/)
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0])
    assert.doesNotMatch(page.url(), /synthetic-operator-token|synthetic-code-DO-NOT-STORE/)
    await page.setViewportSize({ width: 1024, height: 900 })
    await page.goto(base)
    await page.getByRole('heading', { name: 'Inbox' }).waitFor()
    await page.getByRole('button', { name: /First recorded focus item/ }).click()
    await page.getByRole('button', { name: '← Back' }).waitFor()
    assert.equal(await page.locator('.primary-view').isVisible(), false, 'selected inspector takes over the compact desktop view')
    await page.screenshot({ path: `${screenshotDir}/anvil-workbench-1024.png`, fullPage: true })
    await page.getByRole('button', { name: '← Back' }).click()
    await page.locator('.primary-view').waitFor({ state: 'visible' })
    assert.equal(await page.locator('.primary-view').isVisible(), true, 'Back restores the list')
    await page.getByRole('navigation', { name: 'Primary application areas' }).getByRole('link', { name: 'Settings' }).click()
    await page.getByRole('heading', { name: 'Provider credentials' }).waitFor()
    assert.equal(await page.locator('.primary-view').isVisible(), true, 'Settings remains visible at 1024px alongside the inspector')
    assert.equal(await page.getByRole('heading', { name: 'Provider credentials' }).isVisible(), true)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('navigation', { name: 'Primary application areas' }).waitFor()
    assert.equal(await page.locator('.area-nav').evaluate(el => getComputedStyle(el).display), 'flex', 'mobile navigation is horizontal')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile page has no horizontal overflow')
    await page.screenshot({ path: `${screenshotDir}/anvil-workbench-390.png`, fullPage: true })
    await page.getByRole('navigation', { name: 'Primary application areas' }).getByRole('link', { name: 'Settings' }).click()
    await page.getByLabel('Operator token').waitFor()
    assert.equal(await page.locator('#operator-token').isVisible(), true, 'Settings form remains usable at mobile width')
    await page.screenshot({ path: `${screenshotDir}/anvil-workbench-390-settings.png`, fullPage: true })
    assert.ok(calls.some(call => call.path === '/v1/capacity') && calls.some(call => call.path === '/v1/sessions'))
    assert.ok(calls.some(call => call.path === '/v1/sessions/session-fixture-1/diff') && calls.some(call => call.path === '/v1/sessions/session-fixture-1/activity'))
    assert.ok(calls.some(call => call.method === 'GET' && call.path === '/v1/provider-credentials/catalog'))
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
})

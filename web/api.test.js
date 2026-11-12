import test from 'node:test'
import assert from 'node:assert/strict'
import { getIdempotencyRecord, isDefinitiveRejection, request, resetIdempotencyRecord, validateSubmission } from './components/api.js'
import { openCodeConversationUrl } from './components/opencode-link.js'

const commission = (local_key, overrides = {}) => ({
  local_key, objective: `Implement ${local_key}`,
  obligations: [{ id: 'check', version: 1, requirement: 'Works as specified', acceptance_expectations: ['Tests pass'] }],
  execution_target: { kind: 'git_repository', project: 'anvil', repository: 'https://example.test/repo', base_ref: 'main' },
  budget: { max_attempts: 3, max_continuations_per_reason: 2, max_verifier_cycles: 1, max_ci_retries: 1, max_execution_seconds: 3600 },
  start_after: [], integration_after: [], ...overrides,
})

test('request distinguishes transport and server errors for safe idempotency reset', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new TypeError('connection lost') }
    await assert.rejects(request('/campaigns'), error => {
      assert.equal(error.status, undefined)
      assert.equal(isDefinitiveRejection(error), false)
      return true
    })

    for (const status of [422, 408, 503]) {
      globalThis.fetch = async () => ({
        status, ok: false, json: async () => ({ message: 'request failed' }),
      })
      await assert.rejects(request('/campaigns'), error => {
        assert.equal(error.status, status)
        assert.equal(isDefinitiveRejection(error), status === 422)
        return true
      })
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('idempotency retries retain the exact payload and reject changed payloads until reset', () => {
  const values = new Map()
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const makeKey = () => 'stable-key'
  const first = getIdempotencyRecord(storage, 'campaign', '{"purpose":"one"}', makeKey)
  assert.deepEqual(first, { record: { key: 'stable-key', payload: '{"purpose":"one"}' }, conflict: false })
  assert.deepEqual(getIdempotencyRecord(storage, 'campaign', '{"purpose":"one"}', makeKey), first)
  assert.equal(getIdempotencyRecord(storage, 'campaign', '{"purpose":"two"}', makeKey).conflict, true)
  resetIdempotencyRecord(storage, 'campaign')
  assert.equal(getIdempotencyRecord(storage, 'campaign', '{"purpose":"two"}', makeKey).record.payload, '{"purpose":"two"}')
})

test('start idempotency record is bound to expected version', () => {
  const values = new Map()
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const atVersionOne = getIdempotencyRecord(storage, 'start', JSON.stringify({ expected_version: 1 }), () => 'start-key')
  assert.equal(getIdempotencyRecord(storage, 'start', JSON.stringify({ expected_version: 1 })).record.key, atVersionOne.record.key)
  assert.equal(getIdempotencyRecord(storage, 'start', JSON.stringify({ expected_version: 2 })).conflict, true)
})

test('legacy key without a saved payload requires an explicit reset', () => {
  const storage = { getItem: () => 'legacy-key', setItem() {}, removeItem() {} }
  const result = getIdempotencyRecord(storage, 'campaign', '{"purpose":"new"}')
  assert.equal(result.record.key, 'legacy-key')
  assert.equal(result.conflict, true)
})

test('submission validation accepts multiple commissions and local-key dependencies', () => {
  const result = { campaign: { purpose: 'A goal', shared_contracts: [] }, commissions: [commission('foundation'), commission('app', { start_after: ['foundation'] })] }
  assert.deepEqual(validateSubmission(result), [])
})

test('submission validation reports missing, duplicate, and unresolved contracts', () => {
  assert.ok(validateSubmission({ campaign: { purpose: '' }, commissions: [] }).length >= 2)
  const commissions = [commission('same'), commission('same', { start_after: ['missing'] })]
  assert.ok(validateSubmission({ campaign: { purpose: 'ok' }, commissions }).some(error => /unique/.test(error)))
  assert.ok(validateSubmission({ campaign: { purpose: 'ok' }, commissions }).some(error => /unknown dependency/.test(error)))
})

test('submission validation rejects dependency cycles', () => {
  const payload = { campaign: { purpose: 'ok' }, commissions: [commission('one', { start_after: ['two'] }), commission('two', { integration_after: ['one'] })] }
  assert.ok(validateSubmission(payload).some(error => /cycles/.test(error)))
})

test('OpenCode conversation links encode server and session safely', () => {
  const url = openCodeConversationUrl('https://opencode.example.test/workspace/', 'ses/a?#b')
  const serverKey = btoa('https://opencode.example.test/workspace')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  assert.equal(url, `https://opencode.example.test/server/${serverKey}/session/ses%2Fa%3F%23b`)
  assert.equal(openCodeConversationUrl('javascript:alert(1)', 'ses-1'), null)
  assert.equal(openCodeConversationUrl('https://example.test', '  '), null)
})

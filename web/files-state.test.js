import test from 'node:test'
import assert from 'node:assert/strict'
import { createFilesDiffState, isFilesTabActive } from './files-state.js'

test('stale diff responses cannot replace a newer selected-session result', async () => {
  const pending = []
  const state = createFilesDiffState(() => new Promise((resolve) => pending.push(resolve)))
  const oldRequest = state.refresh('session-1', { force: true })
  const newRequest = state.refresh('session-1', { force: true })
  pending[1]({ status: 'ready', diff: { base_revision: 'new', files: [] } })
  assert.equal((await newRequest).result.diff.base_revision, 'new')
  pending[0]({ status: 'ready', diff: { base_revision: 'old', files: [] } })
  assert.equal((await oldRequest).stale, true)
  assert.equal(state.get('session-1').diff.base_revision, 'new')
})

test('diff polling is only active for a selected Files tab', () => {
  assert.equal(isFilesTabActive({ id: 'session-1' }, 'files'), true)
  assert.equal(isFilesTabActive({ id: 'session-1' }, 'logs'), false)
  assert.equal(isFilesTabActive(null, 'files'), false)
})

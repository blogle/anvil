import test from "node:test"
import assert from "node:assert/strict"
import { applyServerRefresh, detailRenderSignature, formatElapsedValue, operatorState, parseRoute, reconcileSessionRows, sessionUiState } from "./ui-state.js"

test("poll payload preserves local interaction state and selected session", () => {
  const activities = new Map([["demo-12345678", {
    environment_state: "ready",
    execution_state: "idle",
    work_state: "ready_for_review",
    session_binding_state: "available",
  }]])
  const state = {
    selected: "demo-12345678",
    filter: "all",
    tab: "runtime",
    attachOpen: true,
    expandedPrompts: new Set(["request-1"]),
    focusKey: "copy",
    sessions: [],
    activities: new Map(),
  }
  const next = applyServerRefresh(state, [{ id: "demo-12345678" }], activities)
  assert.equal(next.selected, state.selected)
  assert.equal(next.tab, "runtime")
  assert.equal(next.attachOpen, true)
  assert.deepEqual(next.expandedPrompts, new Set(["request-1"]))
  assert.equal(next.focusKey, "copy")
})

test("a poll clears detail when the active filter excludes the selected session", () => {
  const state = { selected: "demo-12345678", filter: "done", sessions: [], activities: new Map() }
  const activities = new Map([["demo-12345678", {
    environment_state: "ready",
    execution_state: "idle",
    work_state: "ready_for_review",
    session_binding_state: "available",
  }]])
  assert.equal(applyServerRefresh(state, [{ id: "demo-12345678" }], activities).selected, null)
})

test("fake clock updates elapsed time without changing the interaction model", () => {
  const now = Date.parse("2026-09-19T12:00:10Z")
  assert.equal(formatElapsedValue("2026-09-19T11:58:00Z", now), "2m 10s")
  assert.equal(formatElapsedValue("1789819200Z", now), "10s")
  assert.equal(operatorState({ environment_state: "ready", execution_state: "idle", work_state: "in_progress", session_binding_state: "available" }), "ready-for-review")
  assert.equal(operatorState({ environment_state: "ready", execution_state: "running", work_state: "ready_for_review" }), "working")
  assert.equal(operatorState({ environment_state: "ready", execution_state: "failed", work_state: "failed" }), "problem")
  assert.equal(operatorState({ environment_state: "provisioning", execution_state: "unavailable", work_state: "in_progress" }), "starting")
  assert.equal(operatorState({ environment_state: "suspended", execution_state: "recovering", work_state: "in_progress" }), "stopped")
  assert.equal(parseRoute("#session/demo-12345678"), "demo-12345678")
  assert.equal(parseRoute("#settings"), null)
})

test("timer ticks and no-op polls retain ready-for-review row identity and one status label", () => {
  const session = { id: "review", project: "Demo", work_branch: "main" }
  const activity = { environment_state: "ready", execution_state: "idle", work_state: "ready_for_review", work_state_changed_at: "2026-09-19T11:58:00Z" }
  const stateLabel = (status) => status === "ready-for-review" ? "Ready for review" : "Working"
  const signature = (item, current) => JSON.stringify([item.project, item.work_branch, operatorState(current)])
  const row = { dataset: { session: session.id }, status: stateLabel(operatorState(activity)), elapsed: "2m 10s" }
  row.dataset.rowSignature = signature(session, activity)
  const tick = (now) => { row.elapsed = formatElapsedValue(activity.work_state_changed_at, now) }
  const poll = (nextActivity) => reconcileSessionRows([row], [session], (item) => signature(item, nextActivity), () => ({ dataset: { session: session.id }, status: stateLabel(operatorState(nextActivity)) }))[0]

  tick(Date.parse("2026-09-19T12:00:11Z"))
  assert.equal(row.elapsed, "2m 11s")
  assert.equal(poll({ ...activity }), row)
  assert.equal(row.status, "Ready for review")
  assert.equal(row.status.split("Ready for review").length - 1, 1)
  assert.equal(poll({ ...activity, session_binding_checked_at: "2026-09-19T12:00:12Z" }), row)
})

test("no-op polls retain another stable session row", () => {
  const session = { id: "working", project: "Demo", work_branch: "feature" }
  const activity = { environment_state: "ready", execution_state: "running", work_state: "in_progress" }
  const row = { dataset: { session: session.id, rowSignature: JSON.stringify([operatorState(activity)]) } }
  const retained = reconcileSessionRows([row], [session], () => JSON.stringify([operatorState(activity)]), () => ({ dataset: {} }))[0]
  assert.equal(retained, row)
})

test("volatile binding checks do not change the detail render signature", () => {
  const activity = { session: { id: "demo-12345678" }, session_binding_checked_at: "2026-09-19T12:00:00Z", requests: [] }
  const next = { ...activity, session_binding_checked_at: "2026-09-19T12:00:04Z" }
  assert.deepEqual(detailRenderSignature(activity), detailRenderSignature(next))
})

test("detail interaction state is scoped to each session", () => {
  const state = { sessionUi: new Map() }
  const first = sessionUiState(state, "first")
  first.attachOpen = true
  first.expandedPrompts.add("request-1")
  first.tab = "runtime"
  first.focusKey = "copy"
  const second = sessionUiState(state, "second")
  assert.equal(second.attachOpen, false)
  assert.deepEqual(second.expandedPrompts, new Set())
  assert.equal(second.tab, "logs")
  assert.equal(second.focusKey, null)
})

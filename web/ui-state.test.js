import test from "node:test"
import assert from "node:assert/strict"
import { applyServerRefresh, formatElapsedValue, operatorState, parseRoute } from "./ui-state.js"

test("poll payload preserves local interaction state and selected session", () => {
  const activities = new Map([["demo-12345678", {
    environment_state: "ready",
    execution_state: "idle",
    work_state: "in_progress",
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
    work_state: "in_progress",
    session_binding_state: "available",
  }]])
  assert.equal(applyServerRefresh(state, [{ id: "demo-12345678" }], activities).selected, null)
})

test("fake clock updates elapsed time without changing the interaction model", () => {
  const now = Date.parse("2026-09-19T12:00:10Z")
  assert.equal(formatElapsedValue("2026-09-19T11:58:00Z", now), "2m 10s")
  assert.equal(operatorState({ environment_state: "ready", execution_state: "idle", work_state: "in_progress", session_binding_state: "available" }), "working")
  assert.equal(parseRoute("#session/demo-12345678"), "demo-12345678")
  assert.equal(parseRoute("#settings"), null)
})

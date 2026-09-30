import test from "node:test"
import assert from "node:assert/strict"
import { applyServerRefresh, detailRenderSignature, formatElapsedValue, operatorState, parseRoute, reconcileSessionRows, sessionUiState } from "./ui-state.js"
import { readFile } from "node:fs/promises"
import { renderFilesResult, updateFilesPanel } from "./files-view.js"
import { createFilesDiffState, FILE_DIFF_REFRESH_MS, isFilesTabActive } from "./files-state.js"

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

test("fake timer and controlled no-op polls retain ready and working row identity", () => {
  const sessions = [
    { id: "review", project: "Demo", work_branch: "main" },
    { id: "working", project: "Demo", work_branch: "feature" },
  ]
  const activities = new Map([
    ["review", { environment_state: "ready", execution_state: "idle", work_state: "ready_for_review", work_state_changed_at: "2026-09-19T11:58:00Z" }],
    ["working", { environment_state: "ready", execution_state: "running", work_state: "in_progress", work_state_changed_at: "2026-09-19T11:58:00Z" }],
  ])
  const labels = { "ready-for-review": "Ready for review", working: "Working" }
  const signature = (session, activity) => JSON.stringify([session.project, session.work_branch, operatorState(activity)])
  const rows = sessions.map((session) => {
    const status = labels[operatorState(activities.get(session.id))]
    const row = { dataset: { session: session.id }, status, elapsed: "2m 10s", selected: true, focused: true, hovered: true }
    row.dataset.rowSignature = signature(session, activities.get(session.id))
    return row
  })
  const fakeTimerTick = (now) => rows.forEach((row) => {
    row.elapsed = formatElapsedValue(activities.get(row.dataset.session).work_state_changed_at, now)
  })
  const poll = (response) => reconcileSessionRows(rows, sessions, (session) => signature(session, response.get(session.id)), (session) => ({
    dataset: { session: session.id }, status: labels[operatorState(response.get(session.id))], elapsed: "",
  }))

  fakeTimerTick(Date.parse("2026-09-19T12:00:11Z"))
  assert.deepEqual(rows.map((row) => row.elapsed), ["2m 11s", "2m 11s"])
  const response = new Map([...activities].map(([id, activity]) => [id, { ...activity, session_binding_checked_at: "2026-09-19T12:00:12Z" }]))
  const afterPoll = poll(response)
  assert.deepEqual(afterPoll, rows)
  assert.equal(rows[0].status, "Ready for review")
  assert.equal(rows[0].status.split("Ready for review").length - 1, 1)
  assert.equal(rows[1].status, "Working")
  assert.equal(rows[1].status.split("Working").length - 1, 1)
  assert.ok(rows.every((row) => row.selected && row.focused && row.hovered))
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

test("Files tab renderer covers empty, unavailable, statuses, binary and large files safely", async () => {
  const app = await readFile(new URL("./app.js", import.meta.url), "utf8")
  assert.match(app, /id="files-tab"/)
  assert.match(renderFilesResult({ status: "loading" }), /Loading file changes/)
  assert.match(renderFilesResult({ status: "unavailable", message: "No recorded worker base" }), /Files unavailable[\s\S]*No recorded worker base/)
  assert.match(renderFilesResult({ status: "ready", diff: { base_revision: "abc", files: [] } }), /No file changes/)
  const html = renderFilesResult({ status: "ready", diff: { files: [
    { path: "added<.txt", status: "added", additions: 1, deletions: 0, diff: "+<script>" },
    { path: "renamed.txt", old_path: "old.txt", status: "renamed", additions: 0, deletions: 0, diff: "rename" },
    { path: "image.png", status: "modified", binary: true },
    { path: "huge.txt", status: "modified", too_large: true },
  ] } })
  assert.match(html, /added&lt;\.txt/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /old\.txt → renamed\.txt/)
  assert.match(html, /Binary file/)
  assert.match(html, /Diff too large/)
})

test("Files diff refresh exposes new worktree data without a page reload", async () => {
  let now = 1000
  let request = 0
  const files = createFilesDiffState(async () => ({
    status: "ready",
    diff: { files: [{ path: `change-${++request}.txt`, status: "added", diff: `+version ${request}` }] },
  }), () => now)
  const first = await files.refresh("session", { force: true })
  assert.equal(first.changed, true)
  const firstMarkup = renderFilesResult(first.result)
  assert.match(firstMarkup, /change-1\.txt/)

  now += FILE_DIFF_REFRESH_MS
  assert.equal(files.shouldRefresh("session"), true)
  const second = await files.refresh("session")
  assert.equal(second.changed, true)
  assert.match(renderFilesResult(files.get("session")), /change-2\.txt/)
})

test("stale and out-of-order Files diff responses cannot replace the latest result", async () => {
  const pending = []
  const files = createFilesDiffState(() => new Promise((resolve) => pending.push(resolve)))
  const olderRequest = files.refresh("session", { force: true })
  files.invalidate("session")
  const newerRequest = files.refresh("session", { force: true })
  pending[1]({ status: "ready", diff: { files: [{ path: "new.txt", status: "added", diff: "+new" }] } })
  await newerRequest
  pending[0]({ status: "ready", diff: { files: [{ path: "old.txt", status: "added", diff: "+old" }] } })
  assert.equal((await olderRequest).stale, true)
  assert.equal(files.get("session").diff.files[0].path, "new.txt")
})

test("identical diff updates preserve panel identity and nested scroll position", () => {
  class Panel {
    dataset = {}
    nodes = []
    writes = 0
    set innerHTML(value) {
      this.writes++
      this.markup = value
      this.content = { scrollTop: 0 }
      this.nodes = [{ dataset: { fileKey: '[null,"same.txt"]' }, querySelector: () => this.content }]
    }
    querySelectorAll() { return this.nodes }
  }
  const panel = new Panel()
  const result = { status: "ready", diff: { files: [{ path: "same.txt", status: "modified", diff: "patch" }] } }
  assert.equal(updateFilesPanel(panel, result), true)
  const node = panel.nodes[0]
  const content = panel.content
  content.scrollTop = 91
  assert.equal(updateFilesPanel(panel, structuredClone(result)), false)
  assert.equal(panel.writes, 1)
  assert.equal(panel.nodes[0], node)
  assert.equal(panel.content, content)
  assert.equal(panel.content.scrollTop, 91)
})

test("completed sessions continue to qualify for final Files data while selected", () => {
  assert.equal(isFilesTabActive({ id: "done-session", work_state: "completed", artifacts_exist: true }, "files"), true)
  assert.equal(isFilesTabActive({ id: "done-session", work_state: "completed", artifacts_exist: true }, "logs"), false)
})

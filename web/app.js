const app = document.querySelector("#app")
const state = {
  sessions: [],
  activities: new Map(),
  selected: location.hash.slice(1) || null,
  filter: "all",
  tab: "logs",
  error: null,
  loading: true,
}

const api = async (path, options) => {
  const response = await fetch(path, { headers: { Accept: "application/json" }, ...options })
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message || `Request failed (${response.status})`)
  return response.status === 204 ? null : response.json()
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character])
const timestamp = (value) => {
  if (!value) return null
  const parsed = Number(value)
  if (Number.isFinite(parsed)) return new Date(value.length <= 11 ? parsed * 1000 : parsed)
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
const formatClock = (value) => timestamp(value)?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) || "--:--"
const formatDate = (value) => timestamp(value)?.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) || "Unknown"
const formatElapsed = (request) => {
  const start = timestamp(request.started_at)?.getTime()
  if (!start) return "Unknown duration"
  const end = request.completed_at ? timestamp(request.completed_at)?.getTime() : Date.now()
  if (!end) return "Unknown duration"
  let seconds = Math.max(0, Math.floor((end - start) / 1000))
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}
const formatStateElapsed = (activity) => formatElapsed({ started_at: activity?.work_state_changed_at })
const operatorState = (activity) => {
  if (!activity) return "starting"
  if (["failed"].includes(activity.environment_state) || activity.execution_state === "failed") return "problem"
  if (activity.environment_state === "provisioning") return "starting"
  if (activity.work_state === "awaiting_input") return "needs-input"
  if (activity.execution_state === "running") return "working"
  if (activity.work_state === "ready_for_review") return "ready-for-review"
  if (activity.work_state === "completed") return "done"
  return "working"
}
const stateLabel = (value) => ({ working: "Working", "needs-input": "Needs input", "ready-for-review": "Ready for review", done: "Done", problem: "Problem", starting: "Starting" }[value] || "Starting")
const titleFor = (activity) => {
  const prompt = activity?.requests?.[0]?.prompt?.trim()
  return prompt ? prompt.split("\n")[0].slice(0, 72) : `${activity?.session?.project || "Anvil"} session`
}
const sessionActivity = (id) => state.activities.get(id)
const selectedActivity = () => state.selected ? sessionActivity(state.selected) : null

async function refresh() {
  try {
    const sessions = await api("/v1/sessions")
    state.sessions = sessions
    const ids = sessions.map((session) => session.id)
    await Promise.allSettled(ids.map(async (id) => state.activities.set(id, await api(`/v1/sessions/${encodeURIComponent(id)}/activity`))))
    if (state.selected && !ids.includes(state.selected)) {
      state.selected = ids[0] || null
      updateHash()
    }
    state.error = null
  } catch (error) {
    state.error = error.message
  } finally {
    state.loading = false
    render()
  }
}

function updateHash() {
  const hash = state.selected ? `#${encodeURIComponent(state.selected)}` : ""
  if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname)
}

function visibleSessions() {
  return state.sessions.filter((session) => {
    if (state.filter === "all") return true
    const activity = sessionActivity(session.id)
    const value = operatorState(activity)
    return value === state.filter
  })
}

function render() {
  const mobileDetail = Boolean(state.selected)
  app.className = mobileDetail ? "mobile-detail" : ""
  app.innerHTML = `<div class="app-shell">
    <header class="topbar">
      <a class="brand" href="${location.pathname}" aria-label="Anvil Sessions">
        <svg class="brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 17.5h18M5.4 17.5l2.2-6.2h8.7l2.3 6.2M7.2 11.3V8.2h9.6v3.1M4.8 8.2h14.4M10.1 8.2V5.3h3.8v2.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>Anvil</span>
      </a>
      <nav class="nav" aria-label="Primary"><a class="active" href="${location.pathname}">Sessions</a><a href="${location.pathname}#providers">Providers</a><a href="${location.pathname}#settings">Settings</a></nav>
      <div class="topbar-status"><span class="status-dot"></span>Control plane connected</div>
    </header>
    <main class="workspace">
      ${renderSidebar()}
      ${renderDetail()}
    </main>
  </div>`
  bindEvents()
}

function renderSidebar() {
  const items = visibleSessions()
  return `<aside class="sidebar" aria-label="Sessions">
    <div class="sidebar-head"><h1>Sessions</h1><span class="count">${state.sessions.length} total</span></div>
     <div class="filters" role="tablist" aria-label="Session filters">${[["all", "All"], ["working", "Working"], ["needs-input", "Needs input"], ["ready-for-review", "Ready for review"], ["done", "Done"], ["problem", "Problem"]].map(([filter, label]) => `<button class="filter ${state.filter === filter ? "selected" : ""}" data-filter="${filter}" role="tab" aria-selected="${state.filter === filter}">${label}</button>`).join("")}</div>
    <div class="session-list">${state.loading ? `<div class="loading">Loading sessions...</div>` : state.error && !state.sessions.length ? `<div class="error-card"><strong>Sessions unavailable</strong>${escapeHtml(state.error)}</div>` : items.length ? items.map(renderSessionRow).join("") : `<div class="empty"><strong>${state.filter === "all" ? "No sessions yet" : `No ${state.filter} sessions`}</strong><span>Anvil sessions will appear here when work is dispatched.</span></div>`}</div>
  </aside>`
}

function renderSessionRow(session) {
  const activity = sessionActivity(session.id)
  const status = operatorState(activity)
  const request = activity?.requests?.at(-1)
  const meta = `${stateLabel(status)} · ${formatStateElapsed(activity)}`
  return `<button class="session-row ${state.selected === session.id ? "selected" : ""}" data-session="${escapeHtml(session.id)}"><div class="session-title">${escapeHtml(titleFor(activity))}</div><div class="session-meta"><span>${escapeHtml(session.project)}</span><span>·</span><span><code>${escapeHtml(session.work_branch)}</code></span></div><div class="session-state state-${escapeHtml(status)}"><span class="status-dot"></span><span>${stateLabel(status)}</span><span class="row-detail">${escapeHtml(meta)}</span></div></button>`
}

function relativeTime(value) {
  const date = timestamp(value)
  if (!date) return "recently"
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function renderDetail() {
  if (!state.selected) return `<section class="detail"><div class="detail-inner"><div class="empty"><strong>Select a session</strong>Choose a session to inspect its lifecycle and requests.</div></div></section>`
  const activity = selectedActivity()
  const session = activity?.session || state.sessions.find((item) => item.id === state.selected)
  if (!session) return `<section class="detail"><div class="detail-inner"><div class="loading">Loading session...</div></div></section>`
  const status = operatorState(activity)
  const firstPrompt = activity?.requests?.[0]?.prompt
  return `<section class="detail"><div class="detail-inner">
    <a class="back-link" href="${location.pathname}" data-clear-selection>← All sessions</a>
     <div class="detail-header"><div><div class="eyebrow">Session overview</div><h2>${escapeHtml(titleFor(activity))}</h2><div class="detail-subtitle"><span>${escapeHtml(session.project)}</span><span>·</span><code>${escapeHtml(session.work_branch)}</code></div><div class="detail-status state-${escapeHtml(status)}"><span class="status-dot"></span><strong>${stateLabel(status)}</strong><span>${activity?.work_state_changed_at ? `· ${formatStateElapsed(activity)}` : ""}</span></div></div></div>
     ${activity?.work_state_summary ? `<div class="work-summary"><div class="eyebrow">Work summary</div>${escapeHtml(activity.work_state_summary)}</div>` : ""}
    ${firstPrompt ? `<p class="description">${escapeHtml(firstPrompt)}</p>` : ""}
    ${renderActions(activity, session)}
    <div class="tabs" role="tablist"><button class="tab ${state.tab === "logs" ? "active" : ""}" data-tab="logs" role="tab">Logs</button><button class="tab ${state.tab === "runtime" ? "active" : ""}" data-tab="runtime" role="tab">Runtime</button></div>
    ${state.tab === "logs" ? renderLogs(activity) : renderRuntime(activity, session)}
  </div></section>`
}

function renderActions(activity, session) {
  const preview = activity?.preview_url
  const opencode = activity?.opencode_url
  return `<div class="actions">${preview ? `<a class="button primary" href="${escapeHtml(preview)}" target="_blank" rel="noreferrer">Open Preview</a>` : ""}${opencode ? `<a class="button" href="${escapeHtml(opencode)}" target="_blank" rel="noreferrer">Open in OpenCode</a>` : ""}<div class="attach"><details><summary class="button">Attach <span aria-hidden="true">⌄</span></summary><div class="attach-menu"><p>Run this command from a terminal with Anvil access.</p><code class="command">${escapeHtml(activity?.attach_command || `anvilctl sessions attach ${session.id}`)}</code><button class="button" data-copy="${escapeHtml(activity?.attach_command || `anvilctl sessions attach ${session.id}`)}" style="margin-top:9px">Copy command</button></div></details></div><button class="button danger" data-stop="${escapeHtml(session.id)}">Stop Session</button></div>`
}

function renderLogs(activity) {
  if (!activity) return `<div class="content-section"><div class="loading">Loading activity...</div></div>`
  if (!activity.requests.length && !activity.lifecycle.length) return `<div class="content-section"><div class="empty"><strong>No activity recorded</strong>OpenCode has not reported any requests for this session yet.</div></div>`
  const lifecycle = activity.lifecycle.map((event) => `<div class="timeline-event event-${escapeHtml(event.kind)}"><div class="event-time">${formatClock(event.at)}</div><div class="event-body"><span class="event-marker"></span><div class="event-title">${escapeHtml(eventTitle(event.kind))}</div>${event.detail ? `<div class="event-detail">${escapeHtml(event.detail)}</div>` : ""}</div></div>`).join("")
  const requests = activity.requests.map(renderRequest).join("")
  return `<div class="content-section"><div class="section-heading"><h3>Lifecycle & requests</h3><span>${activity.requests.length} request${activity.requests.length === 1 ? "" : "s"}</span></div><div class="timeline">${lifecycle}${requests}</div></div>`
}

function eventTitle(kind) {
  return { created: "Session created by controller", ready: "Sandbox ready", request_started: "Request started", request_completed: "Request completed", request_failed: "Request failed" }[kind] || "Session activity"
}

function renderRequest(request) {
  const expanded = request.prompt.length < 500
  return `<article class="request-card ${escapeHtml(request.state)}"><div class="request-top"><span><strong>Request #${request.number}</strong> · ${escapeHtml(request.origin)}</span><span class="request-duration">${request.state === "running" ? "Running · " : request.state === "completed" ? "Completed · " : request.state === "failed" ? "Failed · " : ""}${formatElapsed(request)}</span></div><div class="prompt-label">Submitted prompt</div><pre class="prompt ${expanded ? "expanded" : ""}" data-prompt>${escapeHtml(request.prompt)}</pre>${expanded ? "" : `<button class="prompt-toggle" data-expand-prompt>Show full prompt</button>`}<div class="request-info"><span>Started ${formatDate(request.started_at)}</span>${request.completed_at ? `<span>Ended ${formatDate(request.completed_at)}</span>` : `<span>Last activity ${relativeTime(request.last_activity_at)}</span>`}${request.provider || request.model ? `<span>${escapeHtml([request.provider, request.model].filter(Boolean).join(" / "))}</span>` : ""}${request.current_operation ? `<span>Now: ${escapeHtml(request.current_operation)}</span>` : ""}</div>${request.error ? `<div class="failure">${escapeHtml(request.error)}</div>` : ""}</article>`
}

function renderRuntime(activity, session) {
  return `<div class="content-section"><div class="section-heading"><h3>Runtime details</h3><span>Technical information</span></div><div class="runtime-grid"><div class="runtime-item"><label>Environment</label><value>${escapeHtml(activity?.environment_state || session.environment_state)}</value></div><div class="runtime-item"><label>Execution</label><value>${escapeHtml(activity?.execution_state || "idle")}</value></div><div class="runtime-item"><label>Work state</label><value>${escapeHtml(activity?.work_state || session.work_state)}</value></div><div class="runtime-item"><label>Created</label><value>${escapeHtml(formatDate(session.created_at))}</value></div><div class="runtime-item"><label>Sandbox</label><value>${escapeHtml(session.sandbox)}</value></div><div class="runtime-item"><label>OpenCode session</label><value>${escapeHtml(session.opencode_session_id || "Not assigned")}</value></div><div class="runtime-item"><label>Repository</label><value>${escapeHtml(session.repository)}</value></div><div class="runtime-item"><label>Base ref</label><value>${escapeHtml(session.base_ref)}</value></div></div><p class="muted" style="font-size:12px;line-height:1.5;margin-top:18px">Environment, execution, and work state are reported independently. Raw runtime output is not exposed by this control plane.</p></div>`
}

function bindEvents() {
  document.querySelectorAll("[data-session]").forEach((element) => element.addEventListener("click", () => { state.selected = element.dataset.session; state.tab = "logs"; updateHash(); render() }))
  document.querySelectorAll("[data-filter]").forEach((element) => element.addEventListener("click", () => { state.filter = element.dataset.filter; render() }))
  document.querySelectorAll("[data-tab]").forEach((element) => element.addEventListener("click", () => { state.tab = element.dataset.tab; render() }))
  document.querySelectorAll("[data-clear-selection]").forEach((element) => element.addEventListener("click", (event) => { event.preventDefault(); state.selected = null; updateHash(); render() }))
  document.querySelectorAll("[data-expand-prompt]").forEach((element) => element.addEventListener("click", () => { element.previousElementSibling.classList.add("expanded"); element.remove() }))
  document.querySelectorAll("[data-copy]").forEach((element) => element.addEventListener("click", async () => { await navigator.clipboard?.writeText(element.dataset.copy); element.textContent = "Copied" }))
  document.querySelectorAll("[data-stop]").forEach((element) => element.addEventListener("click", async () => { if (!confirm("Stop this session? Its workspace and conversation will be deleted.")) return; element.disabled = true; try { await api(`/v1/sessions/${encodeURIComponent(element.dataset.stop)}`, { method: "DELETE" }); state.selected = null; updateHash(); await refresh() } catch (error) { alert(error.message); element.disabled = false } }))
}

window.addEventListener("hashchange", () => { state.selected = decodeURIComponent(location.hash.slice(1)) || null; render() })
refresh()
setInterval(refresh, 4000)
setInterval(() => { if (document.visibilityState === "visible" && state.selected) render() }, 1000)

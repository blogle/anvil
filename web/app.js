import { applyServerRefresh, detailRenderSignature, formatElapsedValue, operatorState, parseRoute, sessionUiState } from "./ui-state.js"

const app = document.querySelector("#app")
const state = {
  sessions: [],
  activities: new Map(),
  selected: parseRoute(location.hash),
  filter: "all",
  sessionUi: new Map(),
  error: null,
  loading: true,
  refreshInFlight: false,
  refreshGeneration: 0,
}

function routeFor(sessionId) {
  return sessionId ? `#session/${encodeURIComponent(sessionId)}` : ""
}

function navigate(sessionId, push = true) {
  const hash = routeFor(sessionId)
  if (location.hash === hash) {
    applyRoute()
    return
  }
  const url = `${location.pathname}${location.search}${hash}`
  if (push) history.pushState(null, "", url)
  else history.replaceState(null, "", url)
  applyRoute()
}

function applyRoute() {
  state.selected = parseRoute(location.hash)
  document.querySelector(".app-shell")?.classList.toggle("mobile-detail", Boolean(state.selected))
  updateSidebar()
  updateDetail()
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
const formatElapsed = (request) => request.completed_at ? formatElapsedValue(request.started_at, timestamp(request.completed_at)?.getTime() || Date.now()) : formatElapsedValue(request.started_at)
const formatStateElapsed = (activity) => formatElapsedValue(activity?.work_state_changed_at)
const stateLabel = (value) => ({ working: "Working", "needs-input": "Needs input", "ready-for-review": "Ready for review", done: "Done", problem: "Problem", starting: "Starting" }[value] || "Starting")
const titleFor = (session) => `${session?.project || "Anvil"} session`
const sessionActivity = (id) => state.activities.get(id)
const selectedActivity = () => state.selected ? sessionActivity(state.selected) : null
const selectedUi = () => state.selected ? sessionUiState(state, state.selected) : null

async function refresh() {
  if (state.refreshInFlight || document.visibilityState === "hidden") return
  state.refreshInFlight = true
  const generation = ++state.refreshGeneration
  try {
    const sessions = await api("/v1/sessions")
    const activities = await Promise.all(sessions.map(async (session) => {
      try {
        return [session.id, await api(`/v1/sessions/${encodeURIComponent(session.id)}/activity`)]
      } catch {
        return [session.id, state.activities.get(session.id)]
      }
    }))
    if (generation !== state.refreshGeneration) return
    Object.assign(state, applyServerRefresh(state, sessions, new Map(activities.filter(([, activity]) => activity))))
    if (state.selected && !state.sessions.some((session) => session.id === state.selected)) navigate(null, false)
    state.error = null
  } catch (error) {
    if (generation === state.refreshGeneration) state.error = error.message
  } finally {
    if (generation === state.refreshGeneration) {
      state.loading = false
      updateSidebar()
      updateDetail()
    }
    state.refreshInFlight = false
  }
}

function visibleSessions() {
  return state.sessions.filter((session) => state.filter === "all" || operatorState(sessionActivity(session.id)) === state.filter)
}

function ensureShell() {
  if (document.querySelector(".app-shell")) return
  app.innerHTML = `<div class="app-shell">
    <header class="topbar">
      <a class="brand" href="${location.pathname}" aria-label="Anvil Sessions">
        <svg class="brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 17.5h18M5.4 17.5l2.2-6.2h8.7l2.3 6.2M7.2 11.3V8.2h9.6v3.1M4.8 8.2h14.4M10.1 8.2V5.3h3.8v2.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>Anvil</span>
      </a>
      <nav class="nav" aria-label="Primary"><a class="active" href="${location.pathname}">Sessions</a></nav>
      <div class="topbar-status"><span class="status-dot"></span>Control plane connected</div>
    </header>
    <main class="workspace"><aside id="sidebar" class="sidebar" aria-label="Sessions"></aside><section id="detail" class="detail"></section></main>
  </div>`
  app.addEventListener("click", handleClick)
  app.addEventListener("toggle", (event) => {
    if (event.target.matches("[data-attach]")) {
      const ui = selectedUi()
      if (ui) ui.attachOpen = event.target.open
    }
  }, true)
}

function updateSidebar() {
  ensureShell()
  const sidebar = document.querySelector("#sidebar")
  const focused = sidebar.querySelector(":focus")?.dataset.focusKey || null
  const items = visibleSessions()
  sidebar.innerHTML = `<div class="sidebar-head"><h1>Sessions</h1><span class="count">${state.sessions.length} total</span></div>
    <div class="filters" aria-label="Session filters">${[["all", "All"], ["working", "Working"], ["needs-input", "Needs input"], ["ready-for-review", "Ready for review"], ["done", "Done"], ["problem", "Problem"]].map(([filter, label]) => `<button class="filter ${state.filter === filter ? "selected" : ""}" data-focus-key="filter-${filter}" data-filter="${filter}" aria-pressed="${state.filter === filter}">${label}</button>`).join("")}</div>
    <div class="session-list">${state.loading ? `<div class="loading">Loading sessions...</div>` : state.error && !state.sessions.length ? `<div class="error-card"><strong>Sessions unavailable</strong>${escapeHtml(state.error)}</div>` : items.length ? items.map(renderSessionRow).join("") : `<div class="empty"><strong>${state.filter === "all" ? "No sessions yet" : `No ${state.filter} sessions`}</strong><span>${state.filter === "all" ? "Anvil sessions will appear here when work is dispatched." : "No sessions match this filter."}</span></div>`}</div>`
  if (focused) sidebar.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
}

function renderSessionRow(session) {
  const activity = sessionActivity(session.id)
  const status = operatorState(activity)
  const meta = `${stateLabel(status)} · ${formatStateElapsed(activity)}`
  return `<button class="session-row ${state.selected === session.id ? "selected" : ""}" data-focus-key="session-${escapeHtml(session.id)}" data-session="${escapeHtml(session.id)}" aria-current="${state.selected === session.id ? "true" : "false"}"><div class="session-title">${escapeHtml(titleFor(session))}</div><div class="session-meta"><span>${escapeHtml(session.project)}</span><span>·</span><span><code>${escapeHtml(session.work_branch)}</code></span></div><div class="session-state state-${escapeHtml(status)}"><span class="status-dot"></span><span>${stateLabel(status)}</span><span class="row-detail" data-live-state-elapsed="${escapeHtml(activity?.work_state_changed_at)}">${escapeHtml(meta)}</span></div></button>`
}

function captureDetailInteraction() {
  const detail = document.querySelector("#detail")
  const ui = selectedUi()
  const active = document.activeElement?.closest?.("[data-focus-key]")?.dataset.focusKey || null
  const selection = window.getSelection?.()
  const prompt = selection?.anchorNode?.parentElement?.closest?.("[data-prompt]")
  let selectedText = null
  if (prompt && selection.rangeCount) selectedText = { text: selection.toString(), prompt: prompt.dataset.promptId }
  if (ui) Object.assign(ui, { scrollTop: detail.scrollTop, focusKey: active, selectedText })
  return { scrollTop: detail.scrollTop, active, selectedText }
}

function restoreDetailInteraction(saved) {
  const detail = document.querySelector("#detail")
  detail.scrollTop = saved.scrollTop
  if (saved.active) detail.querySelector(`[data-focus-key="${CSS.escape(saved.active)}"]`)?.focus({ preventScroll: true })
  if (saved.selectedText?.text) {
    const prompt = detail.querySelector(`[data-prompt-id="${CSS.escape(saved.selectedText.prompt)}"]`)
    if (prompt) {
      const walker = document.createTreeWalker(prompt, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const index = node.nodeValue.indexOf(saved.selectedText.text)
        if (index >= 0) {
          const range = document.createRange()
          range.setStart(node, index)
          range.setEnd(node, index + saved.selectedText.text.length)
          const selection = window.getSelection()
          selection.removeAllRanges()
          selection.addRange(range)
          break
        }
      }
    }
  }
}

function updateDetail() {
  ensureShell()
  const detail = document.querySelector("#detail")
  const activity = selectedActivity()
  const session = activity?.session || state.sessions.find((item) => item.id === state.selected)
  const signature = JSON.stringify(detailRenderSignature({ selected: state.selected, activity, session }))
  if (detail.dataset.detailSignature === signature) {
    updateDetailTab()
    return
  }
  const saved = captureDetailInteraction()
  detail.dataset.detailSignature = signature
  detail.innerHTML = renderDetail(activity, session)
  restoreDetailInteraction(saved)
  updateDetailTab()
}

function renderDetail(activity, session) {
  if (!state.selected) return `<div class="detail-inner"><div class="empty"><strong>Select a session</strong>Choose a session to inspect its lifecycle and requests.</div></div>`
  if (!session) return `<div class="detail-inner"><div class="loading">Loading session...</div></div>`
  const status = operatorState(activity)
  const attachCommand = activity?.attach_command || `anvilctl sessions attach ${session.id}`
  return `<div class="detail-inner">
    <a class="back-link" href="${location.pathname}" data-clear-selection>All sessions</a>
     <div class="detail-header"><div><div class="eyebrow">Session overview</div><h2>${escapeHtml(titleFor(session))}</h2><div class="detail-subtitle"><span>${escapeHtml(session.project)}</span><span>·</span><code>${escapeHtml(session.work_branch)}</code></div><div class="detail-status state-${escapeHtml(status)}"><span class="status-dot"></span><strong>${stateLabel(status)}</strong><span>${activity?.work_state_changed_at ? `· <span data-live-state-elapsed="${escapeHtml(activity.work_state_changed_at)}">${formatStateElapsed(activity)}</span>` : ""}</span></div></div></div>
     ${(activity?.environment_error || session.environment_error) ? `<div class="recovery-card"><strong>Environment problem</strong><span>${escapeHtml(activity?.environment_error || session.environment_error)}</span></div>` : ""}
     ${activity?.session_binding_error || activity?.session_binding_recovery_event ? `<div class="recovery-card"><strong>${activity.session_binding_recovery_event ? "Conversation rebound" : "OpenCode conversation unavailable"}</strong><span>${escapeHtml(activity.session_binding_error || activity.session_binding_recovery_event)}</span>${activity.session_binding_state === "missing" ? `<button class="button" data-focus-key="rebind" data-rebind="${escapeHtml(session.id)}">Rebind workspace</button>` : ""}</div>` : ""}
    ${activity?.work_state_summary ? `<div class="work-summary"><div class="eyebrow">Work summary</div>${escapeHtml(activity.work_state_summary)}</div>` : ""}
     ${renderActions(activity, session, attachCommand)}
     <div class="tabs" role="tablist" aria-label="Session detail"><button id="logs-tab" class="tab" data-tab="logs" data-focus-key="tab-logs" role="tab" aria-controls="logs-panel">Logs</button><button id="runtime-tab" class="tab" data-tab="runtime" data-focus-key="tab-runtime" role="tab" aria-controls="runtime-panel">Runtime</button></div>
     <div id="logs-panel" role="tabpanel" tabindex="0" aria-labelledby="logs-tab">${renderLogs(activity)}</div><div id="runtime-panel" role="tabpanel" tabindex="0" aria-labelledby="runtime-tab">${renderRuntime(activity, session)}</div>
  </div>`
}

function renderActions(activity, session, attachCommand) {
  const preview = activity?.preview_url
  const opencode = activity?.opencode_url
  const complete = activity?.work_state === "ready_for_review" ? `<button class="button primary" data-focus-key="complete" data-complete="${escapeHtml(session.id)}">Accept and complete</button>` : ""
  const ui = sessionUiState(state, session.id)
  return `<div class="actions">${preview ? `<a class="button primary" href="${escapeHtml(preview)}" target="_blank" rel="noreferrer">Open Preview</a>` : ""}${opencode ? `<a class="button" href="${escapeHtml(opencode)}" target="_blank" rel="noreferrer">Open in OpenCode</a>` : ""}${complete}<div class="attach"><details data-attach ${ui.attachOpen ? "open" : ""}><summary class="button">Attach <span aria-hidden="true">⌄</span></summary><div class="attach-menu"><p>Run this command from a terminal with Anvil access.</p><code class="command">${escapeHtml(attachCommand)}</code><button class="button" data-focus-key="copy" data-copy="${escapeHtml(attachCommand)}" style="margin-top:9px">${ui.copyStatus || "Copy command"}</button><span class="sr-only" aria-live="polite">${escapeHtml(ui.copyStatus || "")}</span></div></details></div><button class="button danger" data-focus-key="stop" data-stop="${escapeHtml(session.id)}">Stop Session</button></div>`
}

function updateDetailTab() {
  const detail = document.querySelector("#detail")
  const ui = selectedUi()
  if (!detail || !ui) return
  const active = ui.tab === "runtime" ? "runtime" : "logs"
  for (const tab of detail.querySelectorAll("[role=tab]")) {
    const selected = tab.dataset.tab === active
    tab.classList.toggle("active", selected)
    tab.setAttribute("aria-selected", String(selected))
    tab.tabIndex = selected ? 0 : -1
  }
  detail.querySelector("#logs-panel")?.toggleAttribute("hidden", active !== "logs")
  detail.querySelector("#runtime-panel")?.toggleAttribute("hidden", active !== "runtime")
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

function renderLogs(activity) {
  if (!activity) return `<div class="content-section"><div class="loading">Loading activity...</div></div>`
  if (!activity.requests.length && !activity.lifecycle.length) return `<div class="content-section"><div class="empty"><strong>No activity recorded</strong>OpenCode has not reported any requests for this session yet.</div></div>`
  const lifecycle = activity.lifecycle.map((event) => `<div class="timeline-event event-${escapeHtml(event.kind)}"><div class="event-time">${formatClock(event.at)}</div><div class="event-body"><span class="event-marker"></span><div class="event-title">${escapeHtml(eventTitle(event.kind))}</div>${event.detail ? `<div class="event-detail">${escapeHtml(event.detail)}</div>` : ""}</div></div>`).join("")
  return `<div class="content-section"><div class="section-heading"><h3>Lifecycle & requests</h3><span>${activity.requests.length} request${activity.requests.length === 1 ? "" : "s"}</span></div><div class="timeline">${lifecycle}${activity.requests.map(renderRequest).join("")}</div></div>`
}

function eventTitle(kind) {
  return { created: "Session created by controller", session_created: "Session created by controller", ready: "Sandbox ready", environment_ready: "Sandbox ready", request_started: "Request started", request_completed: "Request completed", request_failed: "Request failed", run_started: "Work run started", worker_reported: "Worker reported state", conversation_rebound: "Conversation rebound", session_suspended: "Session suspended", session_resumed: "Session resumed", session_completed: "Session completed", session_deleted: "Session deleted" }[kind] || "Session activity"
}

function renderRequest(request) {
  const requestId = request.id || `request-${request.number}`
  const expanded = request.prompt.length < 500 || selectedUi()?.expandedPrompts.has(requestId)
  return `<article class="request-card ${escapeHtml(request.state)}"><div class="request-top"><span><strong>Request #${request.number}</strong> · ${escapeHtml(request.origin)}</span><span class="request-duration">${request.state === "running" ? "Running · " : request.state === "completed" ? "Completed · " : request.state === "failed" ? "Failed · " : ""}<span data-live-elapsed="${escapeHtml(request.started_at)}" data-live-end="${escapeHtml(request.completed_at || "")}">${formatElapsed(request)}</span></span></div><div class="prompt-label">Submitted prompt</div><pre class="prompt ${expanded ? "expanded" : ""}" data-prompt data-prompt-id="${escapeHtml(requestId)}">${escapeHtml(request.prompt)}</pre>${request.prompt.length >= 500 ? `<button class="prompt-toggle" data-focus-key="prompt-${escapeHtml(requestId)}" data-expand-prompt="${escapeHtml(requestId)}">${expanded ? "Collapse prompt" : "Show full prompt"}</button>` : ""}<div class="request-info"><span>Started ${formatDate(request.started_at)}</span>${request.completed_at ? `<span>Ended ${formatDate(request.completed_at)}</span>` : `<span data-live-relative="${escapeHtml(request.last_activity_at || "")}">Last activity ${relativeTime(request.last_activity_at)}</span>`}${request.provider || request.model ? `<span>${escapeHtml([request.provider, request.model].filter(Boolean).join(" / "))}</span>` : ""}${request.current_operation ? `<span>Now: ${escapeHtml(request.current_operation)}</span>` : ""}</div>${request.error ? `<div class="failure">${escapeHtml(request.error)}</div>` : ""}</article>`
}

function renderRuntime(activity, session) {
  return `<div class="content-section"><div class="section-heading"><h3>Runtime details</h3><span>Technical information</span></div>${activity?.environment_error || session.environment_error ? `<div class="failure">${escapeHtml(activity?.environment_error || session.environment_error)}</div>` : ""}<div class="runtime-grid"><div class="runtime-item"><label>Environment</label><span>${escapeHtml(activity?.environment_state || session.environment_state)}</span></div><div class="runtime-item"><label>Execution</label><span>${escapeHtml(activity?.execution_state || "idle")}</span></div><div class="runtime-item"><label>Work state</label><span>${escapeHtml(activity?.work_state || session.work_state)}</span></div><div class="runtime-item"><label>Conversation binding</label><span>${escapeHtml(activity?.session_binding_state || session.session_binding_state || "unknown")}</span></div><div class="runtime-item"><label>Continuity</label><span>${escapeHtml(activity?.session_binding_continuity || session.session_binding_continuity || "unknown")}</span></div><div class="runtime-item"><label>Created</label><span>${escapeHtml(formatDate(session.created_at))}</span></div><div class="runtime-item"><label>Sandbox</label><span>${escapeHtml(session.sandbox)}</span></div><div class="runtime-item"><label>OpenCode session</label><span>${escapeHtml(session.opencode_session_id || "Not assigned")}</span></div><div class="runtime-item"><label>Repository</label><span>${escapeHtml(session.repository)}</span></div><div class="runtime-item"><label>Base ref</label><span>${escapeHtml(session.base_ref)}</span></div></div><p class="muted" style="font-size:12px;line-height:1.5;margin-top:18px">Environment, execution, work state, and conversation binding are reported independently. Rebinding creates a new conversation and loses exact continuity.</p></div>`
}

async function handleClick(event) {
  const session = event.target.closest("[data-session]")
  if (session) {
    navigate(session.dataset.session)
    return
  }
  const filter = event.target.closest("[data-filter]")
  if (filter) {
    state.filter = filter.dataset.filter
    if (state.selected && !visibleSessions().some((item) => item.id === state.selected)) navigate(null, false)
    else updateSidebar()
    return
  }
  const tab = event.target.closest("[data-tab]")
  if (tab) {
    const ui = selectedUi()
    if (ui) {
      ui.tab = tab.dataset.tab
      updateDetailTab()
    }
    return
  }
  if (event.target.closest("[data-clear-selection]")) {
    event.preventDefault()
    navigate(null)
    return
  }
  const expand = event.target.closest("[data-expand-prompt]")
  if (expand) {
    const ui = selectedUi()
    const id = expand.dataset.expandPrompt
    if (ui?.expandedPrompts.has(id)) ui.expandedPrompts.delete(id)
    else ui?.expandedPrompts.add(id)
    const prompt = document.querySelector(`[data-prompt-id="${CSS.escape(id)}"]`)
    prompt?.classList.toggle("expanded", ui?.expandedPrompts.has(id))
    expand.textContent = ui?.expandedPrompts.has(id) ? "Collapse prompt" : "Show full prompt"
    document.querySelector(`[data-focus-key="prompt-${CSS.escape(id)}"]`)?.focus({ preventScroll: true })
    return
  }
  const copy = event.target.closest("[data-copy]")
  if (copy) {
    const ui = selectedUi()
    try {
      await navigator.clipboard?.writeText(copy.dataset.copy)
      if (ui) ui.copyStatus = "Copied"
      copy.textContent = "Copied"
      copy.parentElement.querySelector(".sr-only").textContent = "Copied command to clipboard"
      window.setTimeout(() => {
        if (ui) ui.copyStatus = null
        if (copy.isConnected) {
          copy.textContent = "Copy command"
          copy.parentElement.querySelector(".sr-only").textContent = ""
        }
      }, 2200)
    } catch {
      if (ui) ui.copyStatus = "Copy failed"
      copy.textContent = "Copy failed"
      copy.parentElement.querySelector(".sr-only").textContent = "Copy failed"
    }
    return
  }
  const stop = event.target.closest("[data-stop]")
  if (stop) {
    if (!confirm("Stop this session? Its workspace and conversation will be deleted.")) return
    stop.disabled = true
    try {
      await api(`/v1/sessions/${encodeURIComponent(stop.dataset.stop)}`, { method: "DELETE" })
      navigate(null, false)
      await refresh()
    } catch (error) {
      alert(error.message)
      stop.disabled = false
    }
    return
  }
  const rebind = event.target.closest("[data-rebind]")
  if (rebind) {
    if (!confirm("Create a new OpenCode conversation for this workspace? Exact conversation continuity is unavailable and will be lost.")) return
    rebind.disabled = true
    try {
      await api(`/v1/sessions/${encodeURIComponent(rebind.dataset.rebind)}/rebind`, { method: "POST", body: JSON.stringify({ prompt: null }) })
      await refresh()
    } catch (error) {
      alert(error.message)
      rebind.disabled = false
    }
  }
  const complete = event.target.closest("[data-complete]")
  if (complete) {
    if (!confirm("Accept this work and mark the session complete?")) return
    complete.disabled = true
    try {
      await api(`/v1/sessions/${encodeURIComponent(complete.dataset.complete)}/complete`, { method: "POST" })
      await refresh()
    } catch (error) {
      alert(error.message)
      complete.disabled = false
    }
  }
}

function updateClocks() {
  if (document.visibilityState !== "visible") return
  document.querySelectorAll("[data-live-elapsed]").forEach((element) => {
    const end = element.dataset.liveEnd ? timestamp(element.dataset.liveEnd)?.getTime() : Date.now()
    element.textContent = formatElapsedValue(element.dataset.liveElapsed, end || Date.now())
  })
  document.querySelectorAll("[data-live-state-elapsed]").forEach((element) => {
    element.textContent = formatElapsedValue(element.dataset.liveStateElapsed)
  })
  document.querySelectorAll("[data-live-relative]").forEach((element) => {
    element.textContent = `Last activity ${relativeTime(element.dataset.liveRelative)}`
  })
}

window.addEventListener("hashchange", applyRoute)
window.addEventListener("popstate", applyRoute)
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh() })
ensureShell()
updateSidebar()
updateDetail()
refresh()
setInterval(refresh, 4000)
setInterval(updateClocks, 1000)

export function parseRoute(hash) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash
  if (!raw || raw === "providers" || raw === "settings") return null
  const encoded = raw.startsWith("session/") ? raw.slice("session/".length) : raw
  try {
    return decodeURIComponent(encoded) || null
  } catch {
    return null
  }
}

export function operatorState(activity) {
  if (!activity) return "starting"
  if (activity.environment_state === "failed" || ["failed", "unavailable"].includes(activity.execution_state) || ["missing", "recovering"].includes(activity.session_binding_state)) return "problem"
  if (activity.environment_state === "provisioning") return "starting"
  if (activity.work_state === "awaiting_input") return "needs-input"
  if (activity.execution_state === "running") return "working"
  if (activity.work_state === "ready_for_review") return "ready-for-review"
  if (activity.work_state === "completed") return "done"
  return "working"
}

export function applyServerRefresh(state, sessions, activities) {
  const next = { ...state, sessions, activities }
  const selectedSession = sessions.find((session) => session.id === state.selected)
  const selectedVisible = selectedSession && (state.filter === "all" || operatorState(activities.get(selectedSession.id)) === state.filter)
  if (!selectedVisible) next.selected = null
  return next
}

export function formatElapsedValue(value, now = Date.now()) {
  const raw = String(value || "")
  let start = Date.parse(raw)
  if (!Number.isFinite(start)) {
    const epoch = Number(raw.endsWith("Z") ? raw.slice(0, -1) : raw)
    if (Number.isFinite(epoch)) start = epoch < 1e12 ? epoch * 1000 : epoch
  }
  if (!Number.isFinite(start)) return "Unknown duration"
  let seconds = Math.max(0, Math.floor((now - start) / 1000))
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

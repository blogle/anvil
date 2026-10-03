import { computed, signal } from '@preact/signals'

export const sessions = signal([])
export const activities = signal(new Map())
export const selected = signal(routeFromHash())
export const filter = signal('all')
export const loading = signal(true)
export const error = signal(null)
export const polling = signal(false)
export const ACTIVITY_EVENT_LIMIT = 500
export const visibleSessions = computed(() => sessions.value.filter((session) => filter.value === 'all' || statusFor(activities.value.get(session.id)) === filter.value))
export const uiBySession = new Map()

export function sessionUI(id) {
  if (!uiBySession.has(id)) uiBySession.set(id, {
    tab: signal('activity'), attachOpen: signal(false), expandedPrompts: signal(new Set()), copyStatus: signal(null), loadingOlder: signal(false), olderError: signal(null),
  })
  return uiBySession.get(id)
}

export function routeFromHash(hash = location.hash) {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw || raw === 'providers' || raw === 'settings') return null
  try { return decodeURIComponent(raw.startsWith('session/') ? raw.slice(8) : raw) || null } catch { return null }
}

export function navigate(id, push = true) {
  const hash = id ? `#session/${encodeURIComponent(id)}` : ''
  if (location.hash !== hash) {
    const url = `${location.pathname}${location.search}${hash}`
    if (push) history.pushState(null, '', url)
    else history.replaceState(null, '', url)
  }
  selected.value = routeFromHash()
  if (selected.value) refreshActivityEvents(selected.value).catch(() => {})
}

export function orderedActivityEvents(activity, limit = ACTIVITY_EVENT_LIMIT) {
  const unique = new Map()
  for (const event of activity?.events || []) {
    const key = event.id || `${event.kind}:${event.at}:${event.title || ''}`
    if (!unique.has(key)) unique.set(key, event)
  }
  return [...unique.values()]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id || a.kind).localeCompare(String(b.id || b.kind)))
    .slice(-Math.max(0, limit))
}

export function mergeActivityPages(latest, previous, olderPage = false, limit = ACTIVITY_EVENT_LIMIT) {
  if (!latest) return previous
  const mergedEvents = [...(latest.events || []), ...(previous?.events || [])]
  const uniqueCount = new Set(mergedEvents.map((event) => event.id || `${event.kind}:${event.at}:${event.title || ''}`)).size
  const events = orderedActivityEvents({ events: mergedEvents }, limit)
  const latestWindow = latest.event_window || {}
  const previousWindow = previous?.event_window || {}
  const loadedOlder = Boolean(olderPage || previousWindow.loaded_older)
  const latestLoaded = latestWindow.loaded_messages ?? latestWindow.returned_messages ?? 0
  const previousLoaded = previousWindow.loaded_messages ?? previousWindow.returned_messages ?? 0
  const hasWindow = latest.event_window || previous?.event_window
  return {
    ...latest,
    events,
    ...(hasWindow ? {
      event_window: {
        ...previousWindow,
        ...latestWindow,
        loaded_messages: olderPage ? latestLoaded + previousLoaded : Math.max(latestLoaded, previousLoaded),
        next_cursor: olderPage || loadedOlder ? previousWindow.next_cursor : latestWindow.next_cursor ?? previousWindow.next_cursor,
        loaded_older: loadedOlder,
        truncated: Boolean(latestWindow.truncated || previousWindow.truncated || uniqueCount > limit),
      },
    } : {}),
  }
}

export function activityKindLabel(event) {
  if (event.kind === 'prompt') return 'YOU'
  if (event.kind === 'message') return 'AGENT'
  if (event.kind === 'error') return 'ERROR'
  if (event.kind !== 'tool') return String(event.kind || 'ACTIVITY').toUpperCase()
  const tool = String(event.tool || 'tool').toLowerCase()
  return ({ bash: 'BASH', read: 'READ', edit: 'EDIT', write: 'WRITE', grep: 'GREP', glob: 'SEARCH' })[tool] || tool.toUpperCase()
}

export function activityHistoryNotice(activity) {
  const window = activity?.event_window
  if (!window?.truncated) return null
  const loaded = window.loaded_messages ?? window.returned_messages
  return `Showing activity from ${loaded} OpenCode messages (page limit ${window.message_limit}); the 500-event transcript cap may omit older events.`
}

export function statusFor(activity) {
  if (!activity) return 'starting'
  if (activity.environment_state === 'failed') return 'problem'
  if (activity.environment_state === 'suspended') return 'stopped'
  if (activity.environment_state === 'provisioning') return 'starting'
  if (['failed', 'unavailable'].includes(activity.execution_state)) return 'problem'
  if (activity.work_state === 'completed') return 'done'
  if (activity.work_state === 'failed') return 'problem'
  if (activity.execution_state === 'running') return 'working'
  if (activity.execution_state === 'idle' || activity.work_state === 'ready_for_review') return 'ready-for-review'
  return 'starting'
}

export const stateLabel = (state) => ({ working: 'Working', 'needs-input': 'Needs input', 'ready-for-review': 'Ready for review', done: 'Done', problem: 'Problem', stopped: 'Stopped', starting: 'Starting' }[state] || 'Starting')
export const timestamp = (value) => {
  if (!value) return null
  const raw = String(value)
  const epoch = Number(raw.endsWith('Z') ? raw.slice(0, -1) : raw)
  if (/^\d+Z?$/.test(raw) && Number.isFinite(epoch)) return new Date(raw.length <= 11 ? epoch * 1000 : epoch)
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
export function elapsed(value, now = Date.now()) {
  const date = timestamp(value)
  if (!date) return 'Unknown duration'
  let seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000))
  const hours = Math.floor(seconds / 3600); seconds %= 3600
  const minutes = Math.floor(seconds / 60); seconds %= 60
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}
export const formatDate = (value) => timestamp(value)?.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) || 'Unknown'
export const formatClock = (value) => timestamp(value)?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '--:--'
export function relativeTime(value, now = Date.now()) {
  const date = timestamp(value)
  if (!date) return 'recently'
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 1440)}d ago`
}

export async function api(path, options) {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, ...options })
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message || `Request failed (${response.status})`)
  return response.status === 204 ? null : response.json()
}

function updateActivity(id, latest, previous, olderPage = false) {
  const next = new Map(activities.value)
  next.set(id, mergeActivityPages(latest, previous, olderPage))
  activities.value = next
}

export async function refreshActivityEvents(id = selected.value) {
  if (!id) return
  const latest = await api(`/v1/sessions/${encodeURIComponent(id)}/activity?include_events=true`)
  updateActivity(id, latest, activities.value.get(id))
}

export async function loadOlderActivity(id) {
  const activity = activities.value.get(id)
  const cursor = activity?.event_window?.next_cursor
  if (!cursor) return
  const ui = sessionUI(id)
  if (ui.loadingOlder.value) return
  ui.loadingOlder.value = true
  ui.olderError.value = null
  try {
    const older = await api(`/v1/sessions/${encodeURIComponent(id)}/activity?include_events=true&before=${encodeURIComponent(cursor)}`)
    updateActivity(id, activities.value.get(id) || activity, older, true)
  } catch (cause) {
    ui.olderError.value = cause.message
    throw cause
  } finally {
    ui.loadingOlder.value = false
  }
}

export async function refresh() {
  if (polling.value || document.visibilityState === 'hidden') return
  polling.value = true
  try {
    const next = await api('/v1/sessions')
    const activityPairs = await Promise.all(next.map(async (session) => {
      try { return [session.id, await api(`/v1/sessions/${encodeURIComponent(session.id)}/activity`)] }
      catch { return [session.id, activities.value.get(session.id)] }
    }))
    sessions.value = next
    const nextActivities = new Map()
    for (const [id, activity] of activityPairs) {
      if (activity) nextActivities.set(id, mergeActivityPages(activity, activities.value.get(id)))
    }
    activities.value = nextActivities
    const active = next.find((item) => item.id === selected.value)
    if (selected.value && (!active || (filter.value !== 'all' && statusFor(activities.value.get(active.id)) !== filter.value))) navigate(null, false)
    else if (active) {
      try { await refreshActivityEvents(active.id) } catch { /* Keep the last transcript while OpenCode reconnects. */ }
    }
    error.value = null
  } catch (cause) { error.value = cause.message }
  finally { loading.value = false; polling.value = false }
}

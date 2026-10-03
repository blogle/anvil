import { computed, signal } from '@preact/signals'

export const sessions = signal([])
export const activities = signal(new Map())
export const selected = signal(routeFromHash())
export const filter = signal('all')
export const loading = signal(true)
export const error = signal(null)
export const polling = signal(false)
export const visibleSessions = computed(() => sessions.value.filter((session) => filter.value === 'all' || statusFor(activities.value.get(session.id)) === filter.value))
export const uiBySession = new Map()

export function sessionUI(id) {
  if (!uiBySession.has(id)) uiBySession.set(id, {
    tab: signal('logs'), attachOpen: signal(false), expandedPrompts: signal(new Set()), copyStatus: signal(null),
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

function exactTimestamp(value) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(String(value || ''))
  if (!match) return null
  const seconds = Date.parse(`${match[1]}${match[3]}`)
  if (!Number.isFinite(seconds)) return null
  return { seconds: BigInt(Math.floor(seconds / 1000)), fraction: (match[2] || '').replace(/0+$/, '') }
}

function compareTimestamps(left, right) {
  const a = exactTimestamp(left)
  const b = exactTimestamp(right)
  if (!a || !b) return a ? -1 : b ? 1 : 0
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1
  const length = Math.max(a.fraction.length, b.fraction.length)
  const af = a.fraction.padEnd(length, '0')
  const bf = b.fraction.padEnd(length, '0')
  return af < bf ? -1 : af > bf ? 1 : 0
}

const compareStableText = (left, right) => left < right ? -1 : left > right ? 1 : 0

// Preserve RFC3339 fractional precision. Exact same-source ties use lifecycle IDs
// or transcript-ordered request number/ID; cross-source ties deterministically put
// lifecycle first because no shared sequence exists (this is not causal ordering).
export function chronologicalTimeline(activity) {
  const items = [
    ...(activity.lifecycle || []).map((event) => ({ type: 'event', value: event, at: event.at, id: event.id || `${event.kind}:${event.at}:${event.detail || ''}` })),
    ...(activity.requests || []).map((request) => ({ type: 'request', value: request, at: request.started_at, number: request.number, id: request.id || '' })),
  ]
  return items.sort((a, b) => compareTimestamps(a.at, b.at) || (a.type === b.type
    ? a.type === 'request' ? a.number - b.number || compareStableText(a.id, b.id) : compareStableText(a.id, b.id)
    : a.type === 'event' ? -1 : 1))
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
    activities.value = new Map(activityPairs.filter(([, activity]) => activity))
    const active = next.find((item) => item.id === selected.value)
    if (selected.value && (!active || (filter.value !== 'all' && statusFor(activities.value.get(active.id)) !== filter.value))) navigate(null, false)
    error.value = null
  } catch (cause) { error.value = cause.message }
  finally { loading.value = false; polling.value = false }
}

import { computed, signal } from '@preact/signals'

export const sessions = signal([])
export const activities = signal(new Map())
export const selected = signal(routeFromHash())
export const search = signal('')
export const environmentFilter = signal('')
export const executionFilter = signal('')
export const loading = signal(true)
export const error = signal(null)
export const polling = signal(false)
export const visibleSessions = computed(() => sessions.value.filter((session) => matchesSessionFilters(session, activities.value.get(session.id), {
  search: search.value,
  environment: environmentFilter.value,
  execution: executionFilter.value,
})))
export const environmentOptions = computed(() => filterValues(
  sessions.value.flatMap((session) => [session.environment_state, activities.value.get(session.id)?.environment_state]),
  environmentFilter.value,
))
export const executionOptions = computed(() => filterValues(
  sessions.value.flatMap((session) => [session.execution_state, activities.value.get(session.id)?.execution_state]),
  executionFilter.value,
))
export const uiBySession = new Map()

export function sessionUI(id) {
  if (!uiBySession.has(id)) uiBySession.set(id, {
    tab: signal('logs'), attachOpen: signal(false), expandedPrompts: signal(new Set()), copyStatus: signal(null),
  })
  return uiBySession.get(id)
}

export function routeFromHash(hash = location.hash) {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw || raw === 'sessions' || !raw.startsWith('session/')) return null
  try { return decodeURIComponent(raw.slice('session/'.length)) || null } catch { return null }
}

export function routeFor(id) {
  return id ? `#session/${encodeURIComponent(id)}` : '#sessions'
}

function setSelectedRoute(id) {
  const previous = selected.value
  if (previous === id) return
  selected.value = id
  const focus = () => {
    if (id) {
      document.querySelector('[data-session-detail] h2')?.focus({ preventScroll: true })
      return
    }
    const row = [...document.querySelectorAll('[data-session]')].find((element) => element.dataset.session === previous && !element.hidden)
    ;(row || document.querySelector('[data-filter="search"]'))?.focus({ preventScroll: true })
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus)
  else setTimeout(focus, 0)
}

export function syncRouteFromHash() {
  setSelectedRoute(routeFromHash())
}

export function navigate(id, push = true) {
  const hash = routeFor(id)
  if (location.hash !== hash) {
    const url = `${location.pathname}${location.search}${hash}`
    if (push) history.pushState(null, '', url)
    else history.replaceState(null, '', url)
  }
  syncRouteFromHash()
}

export function environmentFor(session, activity) {
  return activity?.environment_state || session.environment_state || 'unknown'
}

export function executionFor(session, activity) {
  return activity?.execution_state || session.execution_state || 'unknown'
}

export function matchesSessionFilters(session, activity, filters) {
  const query = String(filters.search || '').trim().toLocaleLowerCase()
  const metadata = [session.project, session.name, session.id, session.repository, session.ref, session.base_ref, session.work_branch]
    .filter(Boolean).join(' ').toLocaleLowerCase()
  return (!query || metadata.includes(query))
    && (!filters.environment || environmentFor(session, activity) === filters.environment)
    && (!filters.execution || executionFor(session, activity) === filters.execution)
}

export function filterValues(values, selectedValue) {
  const result = [...new Set(values.filter(Boolean))].sort()
  if (selectedValue && !result.includes(selectedValue)) result.push(selectedValue)
  return result
}

export function clearSessionFilters() {
  search.value = ''
  environmentFilter.value = ''
  executionFilter.value = ''
}
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
    if (selected.value && !active) navigate(null, false)
    error.value = null
  } catch (cause) { error.value = cause.message }
  finally { loading.value = false; polling.value = false }
}

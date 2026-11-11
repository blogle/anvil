export async function request(path, options = {}) {
  const response = await fetch(`/v1${path}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
  })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || `Request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return body
}

export function isDefinitiveRejection(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
    && ![408, 425, 429].includes(error.status)
}

export function getIdempotencyRecord(storage, storageKey, payload, createKey = () => crypto.randomUUID()) {
  const saved = storage.getItem(storageKey)
  if (saved) {
    let record
    try { record = JSON.parse(saved) } catch { record = { key: saved, payload: null } }
    if (!record || typeof record !== 'object' || typeof record.key !== 'string') record = { key: saved, payload: null }
    return record.payload === payload ? { record, conflict: false } : { record, conflict: true }
  }
  const record = { key: createKey(), payload }
  storage.setItem(storageKey, JSON.stringify(record))
  return { record, conflict: false }
}

export function resetIdempotencyRecord(storage, storageKey) {
  storage.removeItem(storageKey)
}

export function validateSubmission(value) {
  const errors = []
  if (!value?.campaign?.purpose?.trim()) errors.push('Campaign purpose is required.')
  const items = value?.commissions
  if (!Array.isArray(items) || items.length < 1 || items.length > 256) errors.push('Add between 1 and 256 Commissions.')
  const keys = new Set((items || []).map(item => item.local_key))
  if (keys.size !== (items || []).length) errors.push('Commission local keys must be unique.')
  for (const [index, item] of (items || []).entries()) {
    if (!item.local_key?.trim() || !item.objective?.trim()) errors.push(`Commission ${index + 1} needs a local_key and objective.`)
    if (!item.obligations?.length) errors.push(`Commission ${index + 1} needs at least one obligation.`)
    for (const dependency of [...(item.start_after || []), ...(item.integration_after || [])]) {
      if (!keys.has(dependency)) errors.push(`${item.local_key || `Commission ${index + 1}`} references unknown dependency “${dependency}”.`)
      if (dependency === item.local_key) errors.push(`${item.local_key} cannot depend on itself.`)
    }
  }
  const graph = new Map((items || []).map(item => [item.local_key, [...(item.start_after || []), ...(item.integration_after || [])]]))
  const visiting = new Set(), visited = new Set()
  function visit(key) {
    if (visiting.has(key)) return false
    if (visited.has(key)) return true
    visiting.add(key)
    for (const dependency of graph.get(key) || []) if (!visit(dependency)) return false
    visiting.delete(key); visited.add(key); return true
  }
  if ([...graph.keys()].some(key => !visit(key))) errors.push('Dependency graph must not contain cycles.')
  return errors
}

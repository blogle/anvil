export const FILE_DIFF_REFRESH_MS = 5000

export function isFilesTabActive(session, tab) {
  return Boolean(session?.id && tab === "files")
}

export function createFilesDiffState(fetchDiff, now = () => Date.now()) {
  const entries = new Map()
  const generations = new Map()
  const inFlight = new Map()

  return {
    get(sessionId) {
      return entries.get(sessionId)?.result
    },
    invalidate(sessionId) {
      generations.set(sessionId, (generations.get(sessionId) || 0) + 1)
      inFlight.delete(sessionId)
    },
    shouldRefresh(sessionId) {
      const entry = entries.get(sessionId)
      return !entry || now() - entry.updatedAt >= FILE_DIFF_REFRESH_MS
    },
    async refresh(sessionId, { force = false } = {}) {
      if (!force && !this.shouldRefresh(sessionId)) return { skipped: true, changed: false, result: this.get(sessionId) }
      if (!force && inFlight.has(sessionId)) return { skipped: true, changed: false, result: this.get(sessionId) }

      const generation = (generations.get(sessionId) || 0) + 1
      generations.set(sessionId, generation)
      inFlight.set(sessionId, generation)
      let result
      try {
        result = await fetchDiff(sessionId)
      } catch (error) {
        result = { status: "unavailable", message: error?.message || "Unable to load file changes." }
      }
      if (generations.get(sessionId) !== generation) return { stale: true, changed: false, result: this.get(sessionId) }

      const signature = JSON.stringify(result)
      const previous = entries.get(sessionId)
      const changed = previous?.signature !== signature
      entries.set(sessionId, { result, signature, updatedAt: now() })
      if (inFlight.get(sessionId) === generation) inFlight.delete(sessionId)
      return { changed, result }
    },
  }
}

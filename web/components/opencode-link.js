export function openCodeConversationUrl(baseUrl, sessionId) {
  if (typeof baseUrl !== 'string' || !baseUrl || typeof sessionId !== 'string' || !sessionId.trim()) return null
  try {
    const base = new URL(baseUrl)
    if (!['http:', 'https:'].includes(base.protocol)) return null
    const server = base.href.replace(/\/$/, '')
    const serverKey = btoa(Array.from(new TextEncoder().encode(server), byte => String.fromCharCode(byte)).join(''))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    return new URL(`/server/${serverKey}/session/${encodeURIComponent(sessionId)}`, base.origin).href
  } catch { return null }
}

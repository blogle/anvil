export function openCodeConversationUrl(baseUrl, sessionId) {
  if (typeof baseUrl !== 'string' || !baseUrl || typeof sessionId !== 'string' || !sessionId.trim()) return null
  try {
    const base = new URL(baseUrl)
    if (!['http:', 'https:'].includes(base.protocol)) return null
    const server = base.href.replace(/\/$/, '')
    const serverKey = btoa(Array.from(new TextEncoder().encode(server), (byte) => String.fromCharCode(byte)).join(''))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
    return new URL(`/server/${serverKey}/session/${encodeURIComponent(sessionId)}`, base.origin).href
  } catch {
    return null
  }
}

export function openCodeLinkState(session, activity) {
  const url = openCodeConversationUrl(activity?.opencode_url, session?.opencode_session_id)
  if (url) return { url, label: 'Open in OpenCode', disabled: false }
  const waiting = !activity?.opencode_url || !session?.opencode_session_id
  return {
    url: null,
    label: waiting ? 'Open in OpenCode (waiting for conversation)' : 'Open in OpenCode (unavailable)',
    disabled: true,
  }
}

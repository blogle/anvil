import { h, render } from 'preact'
import { useEffect } from 'preact/hooks'
import { now } from './clock-state.js'
import { refresh, routeFromHash, selected } from './state.js'
import { SessionsWorkspace } from './sessions.jsx'
import { SessionDetail } from './detail.jsx'

const React = { createElement: h }

export function AppShell() {
  useEffect(() => {
    const route = () => { selected.value = routeFromHash() }
    window.addEventListener('hashchange', route); window.addEventListener('popstate', route)
    const visibility = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', visibility)
    refresh(); const timer = setInterval(refresh, 4000)
    const clock = setInterval(() => { if (document.visibilityState === 'visible') now.value = Date.now() }, 1000)
    return () => { window.removeEventListener('hashchange', route); window.removeEventListener('popstate', route); document.removeEventListener('visibilitychange', visibility); clearInterval(timer); clearInterval(clock) }
  }, [])
  return <div class={`app-shell ${selected.value ? 'mobile-detail' : ''}`}>
    <header class="topbar"><a class="brand" href={location.pathname} aria-label="Anvil Sessions"><svg class="brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 17.5h18M5.4 17.5l2.2-6.2h8.7l2.3 6.2M7.2 11.3V8.2h9.6v3.1M4.8 8.2h14.4M10.1 8.2V5.3h3.8v2.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Anvil</span></a><nav class="nav" aria-label="Primary"><a class="active" href={location.pathname}>Sessions</a></nav><div class="topbar-status"><span class="status-dot"/>Control plane connected</div></header>
    <main class="workspace"><SessionsWorkspace/><SessionDetail/></main>
  </div>
}

if (typeof window !== 'undefined' && !window.__ANVIL_TEST__) render(<AppShell/>, document.getElementById('app'))

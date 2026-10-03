import { h } from 'preact'
import { activities, api, clearSessionFilters, environmentFor, executionFor, navigate, refresh, selected, sessions, sessionUI, visibleSessions } from './state.js'
import { Logs } from './logs.jsx'
import { Runtime } from './runtime.jsx'
import { openCodeLinkState } from './opencode-link.js'

const React = { createElement: h }

export function SessionDetail() {
  const id = selected.value
  const session = sessions.value.find((item) => item.id === id)
  const activity = activities.value.get(id)
  if (!id) return <aside class="detail" aria-label="Session details"/>
  if (!session) return <aside class="detail" aria-label="Session details"><div class="detail-inner"><a class="back-link" href="#sessions" onClick={(event) => { event.preventDefault(); navigate(null) }}>← All sessions</a><div class="loading">Loading session...</div></div></aside>
  const outsideFilters = !visibleSessions.value.some((item) => item.id === id)
  return <aside class="detail" aria-label="Session details" data-session-detail key={id}><DetailContent session={session} activity={activity} outsideFilters={outsideFilters}/></aside>
}

function DetailContent({ session, activity, outsideFilters }) {
  const ui = sessionUI(session.id)
  const tabs = [
    { id: 'logs', label: 'Logs', content: <Logs activity={activity} ui={ui}/> },
    { id: 'runtime', label: 'Runtime', content: <Runtime activity={activity} session={session}/> },
  ]
  return <div class="detail-inner"><a class="back-link" href="#sessions" onClick={(event) => { event.preventDefault(); navigate(null) }}>← All sessions</a>
    {outsideFilters && <div class="filter-context" role="status">This session is open but hidden by the current search or runtime filters. <button class="text-button" onClick={clearSessionFilters}>Show all sessions</button></div>}
    <div class="detail-header"><div><div class="eyebrow">Session overview</div><h2>{session.project || 'Anvil'} session</h2><div class="detail-subtitle"><span>{session.project}</span><span>·</span><code>{session.work_branch}</code></div><div class="detail-subtitle factual-state"><span>Environment: <code>{environmentFor(session, activity)}</code></span><span>Execution: <code>{executionFor(session, activity)}</code></span></div></div></div>
    <SessionActions session={session} activity={activity} ui={ui}/>
    <div class="tabs" role="tablist" aria-label="Session detail">{tabs.map(({ id, label }) => <button key={id} id={`${id}-tab`} class={`tab ${ui.tab.value === id ? 'active' : ''}`} role="tab" aria-selected={ui.tab.value === id} tabIndex={ui.tab.value === id ? 0 : -1} aria-controls={`${id}-panel`} onClick={() => ui.tab.value = id}>{label}</button>)}</div>
    {tabs.map(({ id, content }) => <div key={id} id={`${id}-panel`} role="tabpanel" tabIndex="0" aria-labelledby={`${id}-tab`} hidden={ui.tab.value !== id}>{content}</div>)}
  </div>
}

function SessionActions({ session, activity, ui }) {
  const attachCommand = activity?.attach_command || `anvilctl sessions attach ${session.id}`
  const openCode = openCodeLinkState(session, activity)
  const perform = async (path, method, message) => { if (!confirm(message)) return; try { await api(path, { method }); await refresh() } catch (cause) { alert(cause.message) } }
  return <div class="actions">{activity?.preview_url && <a class="button primary" href={activity.preview_url} target="_blank" rel="noreferrer">Open Preview</a>}{openCode.url ? <a class="button" data-opencode-link href={openCode.url} target="_blank" rel="noreferrer">{openCode.label}</a> : <button class="button disabled" type="button" data-opencode-disabled disabled aria-label={openCode.label} title={openCode.label}>{openCode.label}</button>}
    <div class="attach"><details open={ui.attachOpen.value} onToggle={(event) => ui.attachOpen.value = event.currentTarget.open}><summary class="button">Attach <span aria-hidden="true">⌄</span></summary><div class="attach-menu"><p>Run this command from a terminal with Anvil access.</p><code class="command">{attachCommand}</code><button class="button" style="margin-top:9px" onClick={async () => { try { await navigator.clipboard?.writeText(attachCommand); ui.copyStatus.value = 'Copied' } catch { ui.copyStatus.value = 'Copy failed' } }}>{ui.copyStatus.value || 'Copy command'}</button><span class="sr-only" aria-live="polite">{ui.copyStatus.value || ''}</span></div></details></div>
    <button class="button danger" onClick={() => perform(`/v1/sessions/${encodeURIComponent(session.id)}`, 'DELETE', 'Stop this session? Its workspace and conversation will be deleted.')}>Stop Session</button></div>
}

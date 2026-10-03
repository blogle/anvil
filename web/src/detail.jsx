import { h } from 'preact'
import { activities, api, navigate, refresh, selected, sessions, sessionUI, stateLabel, statusFor } from './state.js'
import { Clock } from './clock.jsx'
import { Logs } from './logs.jsx'
import { Runtime } from './runtime.jsx'
import { openCodeLinkState } from './opencode-link.js'

const React = { createElement: h }

export function SessionDetail() {
  const id = selected.value
  const session = sessions.value.find((item) => item.id === id)
  const activity = activities.value.get(id)
  if (!id) return <section class="detail"><div class="detail-inner"><div class="empty"><strong>Select a session</strong>Choose a session to inspect its lifecycle and requests.</div></div></section>
  if (!session) return <section class="detail"><div class="detail-inner"><div class="loading">Loading session...</div></div></section>
  return <section class="detail" key={id}><DetailContent session={session} activity={activity}/></section>
}

function DetailContent({ session, activity }) {
  const ui = sessionUI(session.id)
  const status = statusFor(activity)
  return <div class="detail-inner"><a class="back-link" href={location.pathname} onClick={(event) => { event.preventDefault(); navigate(null) }}>All sessions</a>
    <div class="detail-header"><div><div class="eyebrow">Session overview</div><h2>{session.project || 'Anvil'} session</h2><div class="detail-subtitle"><span>{session.project}</span><span>·</span><code>{session.work_branch}</code></div><div class={`detail-status state-${status}`}><span class="status-dot"/><strong>{stateLabel(status)}</strong>{activity?.work_state_changed_at && <span>· <Clock value={activity.work_state_changed_at}/></span>}</div></div></div>
    {activity?.work_state_summary && <div class="work-summary"><div class="eyebrow">Work summary</div>{activity.work_state_summary}</div>}
    <SessionActions session={session} activity={activity} ui={ui}/>
    <div class="tabs" role="tablist" aria-label="Session detail"><button id="logs-tab" class={`tab ${ui.tab.value === 'logs' ? 'active' : ''}`} role="tab" aria-selected={ui.tab.value === 'logs'} tabIndex={ui.tab.value === 'logs' ? 0 : -1} aria-controls="logs-panel" onClick={() => ui.tab.value = 'logs'}>Logs</button><button id="runtime-tab" class={`tab ${ui.tab.value === 'runtime' ? 'active' : ''}`} role="tab" aria-selected={ui.tab.value === 'runtime'} tabIndex={ui.tab.value === 'runtime' ? 0 : -1} aria-controls="runtime-panel" onClick={() => ui.tab.value = 'runtime'}>Runtime</button></div>
    <div id="logs-panel" role="tabpanel" tabIndex="0" aria-labelledby="logs-tab" hidden={ui.tab.value !== 'logs'}><Logs activity={activity} ui={ui}/></div><div id="runtime-panel" role="tabpanel" tabIndex="0" aria-labelledby="runtime-tab" hidden={ui.tab.value !== 'runtime'}><Runtime activity={activity} session={session}/></div>
  </div>
}

function SessionActions({ session, activity, ui }) {
  const attachCommand = activity?.attach_command || `anvilctl sessions attach ${session.id}`
  const openCode = openCodeLinkState(session, activity)
  const perform = async (path, method, message) => { if (!confirm(message)) return; try { await api(path, { method }); await refresh() } catch (cause) { alert(cause.message) } }
  return <div class="actions">{activity?.preview_url && <a class="button primary" href={activity.preview_url} target="_blank" rel="noreferrer">Open Preview</a>}{openCode.url ? <a class="button" data-opencode-link href={openCode.url} target="_blank" rel="noreferrer">{openCode.label}</a> : <button class="button disabled" type="button" data-opencode-disabled disabled aria-label={openCode.label} title={openCode.label}>{openCode.label}</button>}{activity?.work_state === 'ready_for_review' && <button class="button primary" onClick={() => perform(`/v1/sessions/${encodeURIComponent(session.id)}/complete`, 'POST', 'Accept this work and mark the session complete?')}>Accept and complete</button>}
    <div class="attach"><details open={ui.attachOpen.value} onToggle={(event) => ui.attachOpen.value = event.currentTarget.open}><summary class="button">Attach <span aria-hidden="true">⌄</span></summary><div class="attach-menu"><p>Run this command from a terminal with Anvil access.</p><code class="command">{attachCommand}</code><button class="button" style="margin-top:9px" onClick={async () => { try { await navigator.clipboard?.writeText(attachCommand); ui.copyStatus.value = 'Copied' } catch { ui.copyStatus.value = 'Copy failed' } }}>{ui.copyStatus.value || 'Copy command'}</button><span class="sr-only" aria-live="polite">{ui.copyStatus.value || ''}</span></div></details></div>
    <button class="button danger" onClick={() => perform(`/v1/sessions/${encodeURIComponent(session.id)}`, 'DELETE', 'Stop this session? Its workspace and conversation will be deleted.')}>Stop Session</button></div>
}

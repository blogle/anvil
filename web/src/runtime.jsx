import { h } from 'preact'
import { formatDate } from './state.js'

const React = { createElement: h }

export function Runtime({ activity, session }) {
  const items = [['Environment', activity?.environment_state || session.environment_state], ['Execution', activity?.execution_state || 'idle'], ['Work state', activity?.work_state || session.work_state], ['Created', formatDate(session.created_at)], ['Sandbox', session.sandbox], ['Repository', session.repository], ['Base ref', session.base_ref]]
  return <div class="content-section"><div class="section-heading"><h3>Runtime details</h3><span>Technical information</span></div>{(activity?.environment_error || session.environment_error) && <div class="failure">{activity?.environment_error || session.environment_error}</div>}<div class="runtime-grid">{items.map(([label, value]) => <div key={label} class="runtime-item"><label>{label}</label><span>{value}</span></div>)}</div></div>
}

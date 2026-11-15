'use client'

import { useEffect, useRef, useState } from 'react'
import { request } from './api'

export default function ProviderSettings() {
  const [token, setToken] = useState('')
  const [provider, setProvider] = useState('')
  const [key, setKey] = useState('')
  const [credentials, setCredentials] = useState([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const tokenRef = useRef('')

  useEffect(() => () => { tokenRef.current = '' }, [])

  const authorized = { Authorization: `Bearer ${tokenRef.current}` }
  const load = async () => {
    if (!token.trim()) { setError('Enter the operator token to load provider credentials.'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await request('/provider-credentials', { headers: authorized })
      setCredentials(Array.isArray(result) ? result : [])
    } catch {
      setError('Could not load provider credentials. Check the operator token and API availability.')
    } finally { setBusy(false) }
  }

  const save = async event => {
    event.preventDefault()
    const submittedKey = key
    setKey('')
    setError(''); setMessage('')
    if (!token.trim()) { setError('Enter the operator token before saving.'); return }
    if (!provider.trim() || !submittedKey) { setError('Enter a provider ID and API key.'); return }
    setBusy(true)
    try {
      const result = await request(`/provider-credentials/${encodeURIComponent(provider.trim())}`, {
        method: 'PUT', headers: authorized, body: JSON.stringify({ key: submittedKey }),
      })
      setCredentials(current => [...current.filter(item => item.provider_id !== result?.provider_id || item.generation >= result.generation), result])
      setMessage('Credential saved.')
    } catch {
      setError('Could not save the provider credential. Check the operator token, provider ID, and API availability.')
    } finally { setBusy(false) }
  }

  return <>
    <div className="eyebrow">SETTINGS / PROVIDER CREDENTIALS</div>
    <h1>Provider <em>settings.</em></h1>
    <p className="lede">Manage encrypted provider credentials using the operator token. The token and API key remain in this page’s memory only.</p>
    <section className="data-card provider-settings" aria-labelledby="provider-credentials-title">
      <h2 id="provider-credentials-title">Operator access</h2>
      <label htmlFor="operator-token">Operator token</label>
      <input id="operator-token" type="password" autoComplete="off" value={token} onChange={event => { tokenRef.current = event.target.value; setToken(event.target.value) }} />
      <button className="button quiet" type="button" disabled={busy} onClick={load}>{busy ? 'Working…' : 'Load credentials'}</button>
    </section>
    <form className="data-card provider-settings" onSubmit={save}>
      <h2>Save provider API key</h2>
      <label htmlFor="provider-id">Provider ID</label>
      <input id="provider-id" autoComplete="off" value={provider} onChange={event => setProvider(event.target.value)} placeholder="e.g. openai" />
      <label htmlFor="provider-key">API key</label>
      <input id="provider-key" type="password" autoComplete="new-password" value={key} onChange={event => setKey(event.target.value)} />
      <button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save key'}</button>
    </form>
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <p className="notice" role="status">{message}</p>}
    <section className="data-card" aria-labelledby="stored-credentials-title">
      <h2 id="stored-credentials-title">Stored credential generations</h2>
      {credentials.length ? <div className="contract-list">{Object.values(credentials.reduce((latest, item) => {
        if (!latest[item.provider_id] || Number(item.generation) > Number(latest[item.provider_id].generation)) latest[item.provider_id] = item
        return latest
      }, {})).map(item => <div className="contract-row" key={`${item.provider_id}-${item.generation}`}><span className="contract-main"><b>{item.provider_id}</b><small>Generation {item.generation} · {item.created_at}</small></span></div>)}</div> : <p className="muted">No credential metadata loaded.</p>}
    </section>
  </>
}

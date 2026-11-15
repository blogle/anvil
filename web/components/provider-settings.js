'use client'

import { useEffect, useRef, useState } from 'react'
import { request } from './api'

const dateLabel = value => {
  if (!value) return 'Date unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString()
}

const safeHttpUrl = value => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch { return '' }
}

const inspectForm = form => {
  if (form === undefined) return { fields: [], valid: true }
  if (!Array.isArray(form) || form.length === 0) return { fields: [], valid: false }
  const keys = new Set()
  let valid = true
  for (const field of form) {
    if (!field || typeof field !== 'object' || typeof field.key !== 'string' || !field.key || keys.has(field.key)) { valid = false; continue }
    if (!['string', 'number', 'integer', 'boolean', 'multiselect', 'external'].includes(field.type)) valid = false
    if (field.type === 'external' && (!safeHttpUrl(field.url) || field.required !== undefined || field.hidden !== undefined || field.when !== undefined || field.default !== undefined)) valid = false
    if (field.type === 'string' && field.options !== undefined && (!Array.isArray(field.options) || !field.options.every(option => option && typeof option.value === 'string' && typeof option.label === 'string'))) valid = false
    if (field.type === 'multiselect' && (!Array.isArray(field.options) || !field.options.every(option => option && typeof option.value === 'string' && typeof option.label === 'string'))) valid = false
    if (field.required !== undefined && typeof field.required !== 'boolean') valid = false
    if (field.hidden !== undefined && typeof field.hidden !== 'boolean') valid = false
    if (field.when !== undefined && (!Array.isArray(field.when) || !field.when.every(condition => condition && keys.has(condition.key) && ['eq', 'neq'].includes(condition.op) && ['string', 'number', 'boolean'].some(type => typeof condition.value === type)))) valid = false
    if (field.default !== undefined && !(
      (field.type === 'string' && typeof field.default === 'string') ||
      ((field.type === 'number' || field.type === 'integer') && typeof field.default === 'number' && Number.isFinite(field.default)) ||
      (field.type === 'boolean' && typeof field.default === 'boolean') ||
      (field.type === 'multiselect' && Array.isArray(field.default) && field.default.every(value => typeof value === 'string'))
    )) valid = false
    keys.add(field.key)
  }
  return { fields: form, valid }
}

const isActiveField = (field, answers) => !field.hidden && (!field.when || field.when.every(condition => {
  if (!Object.hasOwn(answers, condition.key)) return false
  const answer = answers[condition.key]
  const matches = Array.isArray(answer) ? answer.includes(condition.value) : answer === condition.value
  return condition.op === 'eq' ? matches : !matches
}))

const effectiveAnswers = (fields, answers) => {
  const effective = {}
  for (const field of fields) {
    if (!isActiveField(field, effective)) continue
    if (Object.hasOwn(answers, field.key)) effective[field.key] = answers[field.key]
    else if (field.default !== undefined) effective[field.key] = field.default
    else if (field.type === 'boolean') effective[field.key] = false
  }
  return effective
}

export default function ProviderSettings() {
  const [token, setToken] = useState('')
  const [provider, setProvider] = useState('openai')
  const [key, setKey] = useState('')
  const [credentials, setCredentials] = useState([])
  const [catalog, setCatalog] = useState([])
  const [catalogSearch, setCatalogSearch] = useState('')
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [methods, setMethods] = useState([])
  const [methodId, setMethodId] = useState('')
  const [formAnswers, setFormAnswers] = useState({})
  const [oauth, setOauth] = useState(null)
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const tokenRef = useRef('')
  const providerRef = useRef(provider)
  const pollTimer = useRef(null)
  const mounted = useRef(true)

  const stopPolling = () => {
    if (pollTimer.current !== null) clearTimeout(pollTimer.current)
    pollTimer.current = null
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      tokenRef.current = ''
      stopPolling()
    }
  }, [])

  useEffect(() => {
    providerRef.current = provider
    stopPolling()
    setOauth(null)
    setCode('')
    setMethods([])
    setMethodId('')
    setFormAnswers({})
  }, [provider])

  const authorized = () => ({ Authorization: `Bearer ${tokenRef.current}` })

  const loadCredentials = async () => {
    if (!tokenRef.current.trim()) { setError('Enter the operator token to load provider credentials.'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      const headers = { Authorization: `Bearer ${tokenRef.current}` }
      const [result] = await Promise.all([
        request('/provider-credentials', { headers }),
        loadCatalog(headers),
      ])
      if (mounted.current) setCredentials(Array.isArray(result) ? result : [])
    } catch {
      if (mounted.current) setError('Could not load provider credential metadata. Check the operator token and API availability.')
    } finally { if (mounted.current) setBusy(false) }
  }

  const loadCatalog = async headers => {
    const requestHeaders = headers || authorized()
    if (!tokenRef.current.trim()) { setCatalogError('Enter the operator token before browsing providers.'); return }
    const requestedToken = requestHeaders.Authorization
    setCatalogError('')
    try {
      const result = await request('/provider-credentials/catalog', { headers: requestHeaders })
      if (mounted.current && tokenRef.current === requestedToken.replace(/^Bearer\s+/, '')) {
        setCatalog(Array.isArray(result) ? result.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string') : [])
        setCatalogLoaded(true)
      }
    } catch {
      if (mounted.current && tokenRef.current === requestedToken.replace(/^Bearer\s+/, '')) {
        setCatalog([])
        setCatalogLoaded(false)
        setCatalogError('Could not load the provider catalog. Check the operator token and API availability.')
      }
    }
  }

  const browseProviders = async () => {
    if (!tokenRef.current.trim()) { setCatalogError('Enter the operator token before browsing providers.'); return }
    setBusy(true)
    await loadCatalog({ Authorization: `Bearer ${tokenRef.current}` })
    if (mounted.current) setBusy(false)
  }

  const filteredCatalog = catalog.filter(item => `${item.name} ${item.id}`.toLocaleLowerCase().includes(catalogSearch.trim().toLocaleLowerCase()))

  const loadMethods = async () => {
    const currentProvider = provider.trim()
    if (!tokenRef.current.trim()) { setError('Enter the operator token before loading sign-in methods.'); return }
    if (!currentProvider) { setError('Enter a provider ID before loading sign-in methods.'); return }
    setBusy(true); setError(''); setMethods([]); setMethodId('')
    try {
      const result = await request(`/provider-credentials/${encodeURIComponent(currentProvider)}/methods`, { headers: authorized() })
      if (mounted.current && providerRef.current.trim() === currentProvider) {
        const available = Array.isArray(result?.methods) ? result.methods : []
        setMethods(available)
        const selectedMethod = available.find(method => method.id === 'chatgpt-headless') || available[0]
        setMethodId(selectedMethod?.id || '')
        setFormAnswers({})
      }
    } catch {
      if (mounted.current && providerRef.current.trim() === currentProvider) setError('Sign-in methods are unavailable. Check the operator token, provider ID, and API availability.')
    } finally { if (mounted.current) setBusy(false) }
  }

  const save = async event => {
    event.preventDefault()
    const submittedKey = key
    setKey('')
    setError(''); setMessage('')
    if (!tokenRef.current.trim()) { setError('Enter the operator token before saving.'); return }
    if (!provider.trim() || !submittedKey) { setError('Enter a provider ID and API key.'); return }
    setBusy(true)
    try {
      await request(`/provider-credentials/${encodeURIComponent(provider.trim())}`, {
        method: 'PUT', headers: authorized(), body: JSON.stringify({ key: submittedKey }),
      })
      try {
        const result = await request('/provider-credentials', { headers: authorized() })
        if (mounted.current) {
          setCredentials(Array.isArray(result) ? result : [])
          setMessage('API-key credential saved. Credential metadata refreshed.')
        }
      } catch {
        if (mounted.current) setMessage('API-key credential saved, but credential metadata could not be refreshed.')
      }
    } catch {
      setError('Could not save the provider credential. Check the operator token, provider ID, and API availability.')
    } finally { if (mounted.current) setBusy(false) }
  }

  const pollLogin = async (loginId, currentProvider, expiresAt) => {
    stopPolling()
    const poll = async () => {
      if (!mounted.current || providerRef.current.trim() !== currentProvider) return
      if (Date.now() >= expiresAt) {
        setOauth(current => current?.loginId === loginId ? { ...current, status: 'expired' } : current)
        pollTimer.current = null
        return
      }
      try {
        const result = await request(`/provider-credentials/${encodeURIComponent(currentProvider)}/oauth/${encodeURIComponent(loginId)}`, { headers: authorized() })
        if (!mounted.current || providerRef.current.trim() !== currentProvider) return
        if (result?.status === 'complete') {
          stopPolling()
          setOauth(current => current?.loginId === loginId ? { ...current, status: 'complete' } : current)
          try {
            const refreshed = await request('/provider-credentials', { headers: authorized() })
            if (mounted.current && providerRef.current.trim() === currentProvider) {
              setCredentials(Array.isArray(refreshed) ? refreshed : [])
              setMessage('OAuth credential metadata refreshed.')
            }
          } catch {
            if (mounted.current) setError('OAuth completed, but credential metadata could not be refreshed.')
          }
          return
        }
        if (result?.status === 'failed' || result?.status === 'expired') {
          stopPolling()
          setOauth(current => current?.loginId === loginId ? { ...current, status: result.status } : current)
          return
        }
        if (result?.status !== 'pending') throw new Error('Unexpected OAuth status')
      } catch {
        if (mounted.current && providerRef.current.trim() === currentProvider) {
          stopPolling()
          setOauth(current => current?.loginId === loginId ? { ...current, status: 'error' } : current)
          setError('Could not check OAuth sign-in status. Start a new sign-in or check API availability.')
        }
        return
      }
      if (mounted.current && providerRef.current.trim() === currentProvider) pollTimer.current = setTimeout(poll, 1000)
    }
    pollTimer.current = setTimeout(poll, 1000)
  }

  const startOAuth = async event => {
    event.preventDefault()
    if (!tokenRef.current.trim()) { setError('Enter the operator token before starting OAuth sign-in.'); return }
    if (!provider.trim() || !methodId) { setError(methods.length ? 'Choose a sign-in method.' : 'Load available sign-in methods first.'); return }
    const selectedMethod = methods.find(method => method.id === methodId)
    const form = inspectForm(selectedMethod?.form)
    if (!form.valid) { setError('This method form is not supported; choose another method.'); return }
    const values = effectiveAnswers(form.fields, formAnswers)
    const answer = {}
    for (const field of form.fields) {
      if (!isActiveField(field, values) || field.type === 'external') continue
      const value = values[field.key]
      if (field.required && (value === undefined || value === '' || (Array.isArray(value) && value.length === 0))) {
        setError(`Complete the required field: ${field.title || field.key}.`)
        return
      }
      if (value !== undefined && ((field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) || (field.type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))))) {
        setError(`Enter a valid ${field.type} for ${field.title || field.key}.`)
        return
      }
      if (typeof value === 'number' && ((field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) {
        setError(`Enter a value within the allowed range for ${field.title || field.key}.`)
        return
      }
      if (value !== undefined) answer[field.key] = value
    }
    const currentProvider = provider.trim()
    setBusy(true); setError(''); setMessage(''); setOauth(null); setCode('')
    try {
      const result = await request(`/provider-credentials/${encodeURIComponent(currentProvider)}/oauth`, {
        method: 'POST', headers: authorized(), body: JSON.stringify(form.fields.length ? { method_id: methodId, answer } : { method_id: methodId }),
      })
      setFormAnswers({})
      if (!result?.login_id || !['auto', 'code'].includes(result.mode)) throw new Error('Unexpected OAuth response')
      const expiresAt = Number(result.time?.expires)
      if (!Number.isFinite(expiresAt)) throw new Error('OAuth expiry is missing')
      const safeUrl = (() => {
        try { const parsed = new URL(result.url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '' } catch { return '' }
      })()
      const session = { loginId: result.login_id, mode: result.mode, status: 'pending', url: safeUrl, instructions: result.instructions || '', expiresAt }
      setOauth(session)
      if (result.mode === 'auto') pollLogin(result.login_id, currentProvider, expiresAt)
    } catch {
      if (mounted.current) setError('Could not start OAuth sign-in. Check the operator token, provider, method, and API availability.')
    } finally { if (mounted.current) setBusy(false) }
  }

  const completeOAuth = async event => {
    event.preventDefault()
    if (!oauth || oauth.mode !== 'code' || !code.trim()) { setError('Paste the sign-in code to continue.'); return }
    const currentProvider = provider.trim()
    setBusy(true); setError('')
    try {
      await request(`/provider-credentials/${encodeURIComponent(currentProvider)}/oauth/${encodeURIComponent(oauth.loginId)}/complete`, {
        method: 'POST', headers: authorized(), body: JSON.stringify({ code }),
      })
      setCode('')
      setOauth(current => current ? { ...current, status: 'pending' } : current)
      pollLogin(oauth.loginId, currentProvider, oauth.expiresAt)
    } catch {
      if (mounted.current) setError('Could not submit the sign-in code. Check the code and API availability.')
    } finally { if (mounted.current) setBusy(false) }
  }

  return <>
    <div className="settings-grid provider-settings-grid">
      <section className="settings-card" aria-labelledby="operator-access-title">
        <h2 id="operator-access-title">Operator access</h2>
        <label className="field" htmlFor="operator-token">Operator token<input id="operator-token" type="password" autoComplete="off" value={token} onChange={event => { tokenRef.current = event.target.value; setToken(event.target.value); setCatalog([]); setCatalogLoaded(false); setCatalogError('') }} /></label>
        <button className="btn" type="button" disabled={busy} onClick={loadCredentials}>{busy ? 'Working…' : 'Load credential metadata'}</button>
      </section>

      <section className="settings-card" aria-labelledby="connected-generations-title">
        <h2 id="connected-generations-title">Connected generations</h2>
        {credentials.length ? credentials.map(item => <div className="data-row" key={`${item.provider_id}-${item.generation}`}><span><b>{item.provider_id}</b><br />Generation {item.generation} · {dateLabel(item.created_at)}</span><span className="state">{item.kind === 'oauth' ? 'OAuth' : item.kind === 'key' ? 'API key' : 'Credential'}</span></div>) : <p className="muted">Credential metadata is unavailable until loaded; no authentication status is inferred.</p>}
      </section>

      <form className="settings-card provider-settings-form" onSubmit={save}>
        <h2>Save API key</h2>
        <div className="provider-catalog">
          <button className="btn" type="button" disabled={busy} onClick={browseProviders}>{busy ? 'Working…' : 'Browse providers'}</button>
          {catalogError && <p className="muted" role="alert">{catalogError}</p>}
          {catalogLoaded && catalog.length === 0 && <p className="muted">No providers are listed in the catalog.</p>}
          {catalogLoaded && catalog.length > 0 && <>
            <label className="field" htmlFor="provider-search">Search providers<input id="provider-search" type="search" autoComplete="off" value={catalogSearch} onChange={event => setCatalogSearch(event.target.value)} placeholder="Search by name or ID" /></label>
            <label className="field" htmlFor="provider-catalog-select">Provider catalog<select id="provider-catalog-select" value="" onChange={event => { if (event.target.value) setProvider(event.target.value) }}>
              <option value="">{filteredCatalog.length ? 'Choose a provider' : 'No matching providers'}</option>
              {filteredCatalog.map(item => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}
            </select></label>
            <p className="muted">Catalog entries are provider identifiers only; they do not indicate configured credentials or worker readiness.</p>
          </>}
        </div>
        <label className="field" htmlFor="provider-id">Provider ID<input id="provider-id" autoComplete="off" value={provider} onChange={event => setProvider(event.target.value)} placeholder="e.g. openai or opencode-go" /></label>
        <label className="field" htmlFor="provider-key">API key<input id="provider-key" type="password" autoComplete="new-password" value={key} onChange={event => setKey(event.target.value)} /></label>
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save key'}</button>
      </form>

      <section className="settings-card" aria-labelledby="oauth-title">
        <h2 id="oauth-title">OAuth sign-in</h2>
        <p className="dim">Sign-in is managed by the provider flow; no browser callback is assumed.</p>
        <label className="field" htmlFor="oauth-method">Sign-in method<select id="oauth-method" value={methodId} onChange={event => { setMethodId(event.target.value); setFormAnswers({}); setError(''); setOauth(null) }} disabled={!methods.length}><option value="">{methods.length ? 'Choose a method' : 'Load methods to begin'}</option>{methods.map(method => <option key={method.id} value={method.id}>{method.label}</option>)}</select></label>
        {(() => {
          const selected = methods.find(method => method.id === methodId)
          if (!selected || selected.form === undefined) return null
          const form = inspectForm(selected.form)
          if (!form.valid) return <p className="muted" role="alert">This method form is not supported; choose another method.</p>
          const values = effectiveAnswers(form.fields, formAnswers)
          return form.fields.map(field => {
            if (!isActiveField(field, values)) return null
            if (field.type === 'external') {
              const href = safeHttpUrl(field.url)
              return href ? <p className="field" key={field.key}><a href={href} target="_blank" rel="noopener noreferrer">{field.title || field.key}</a>{field.description && <span>{field.description}</span>}</p> : null
            }
            const value = values[field.key]
            const id = `oauth-field-${field.key}`
            const update = next => setFormAnswers(current => ({ ...current, [field.key]: next }))
            const title = <>{field.title || field.key}{field.required && <> <span aria-hidden="true">*</span></>}</>
            if (field.type === 'boolean') return <label className="field oauth-form-check" key={field.key} htmlFor={id}><span>{title}</span><input id={id} type="checkbox" checked={value ?? false} onChange={event => update(event.target.checked)} />{field.description && <span>{field.description}</span>}</label>
            if (field.type === 'multiselect') return <fieldset className="field oauth-form-options" key={field.key}><legend>{title}</legend>{field.description && <span>{field.description}</span>}{field.options.map(option => <label key={option.value}><input type="checkbox" checked={(value || []).includes(option.value)} onChange={event => update(event.target.checked ? [...(value || []), option.value] : (value || []).filter(item => item !== option.value))} /> {option.label}</label>)}</fieldset>
            const select = field.type === 'string' && Array.isArray(field.options) && field.options.length > 0
            return <label className="field" key={field.key} htmlFor={id}>{title}{field.description && <span>{field.description}</span>}{select ? <select id={id} value={value ?? ''} onChange={event => update(event.target.value)}><option value="">Choose an option</option>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input id={id} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} step={field.type === 'integer' ? '1' : undefined} value={value ?? ''} placeholder={field.placeholder} onChange={event => update(field.type === 'number' || field.type === 'integer' ? (event.target.value === '' ? '' : Number(event.target.value)) : event.target.value)} />}</label>
          })
        })()}
        <button className="btn" type="button" onClick={loadMethods} disabled={busy}>{busy ? 'Working…' : 'Load methods'}</button>
        <form onSubmit={startOAuth}><button className="btn primary" disabled={busy || !methods.length || (methodId && !inspectForm(methods.find(method => method.id === methodId)?.form).valid)}>{busy ? 'Working…' : 'Start OAuth sign-in'}</button></form>
        {methods.length === 0 && <p className="muted">No sign-in methods loaded. The provider may have no available OAuth methods.</p>}
        {oauth && <div className="oauth-session" aria-live="polite">
          {oauth.url && <p><a href={oauth.url} target="_blank" rel="noopener noreferrer">Open provider sign-in</a></p>}
          {oauth.instructions && <p className="callout">{oauth.instructions}</p>}
          {oauth.mode === 'code' && oauth.status === 'pending' && <form className="provider-code-form" onSubmit={completeOAuth}><label className="field" htmlFor="oauth-code">Paste sign-in code<input id="oauth-code" type="password" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} /></label><button className="btn primary" disabled={busy || !code.trim()}>{busy ? 'Submitting…' : 'Complete sign-in'}</button></form>}
          <p className="dim">{oauth.status === 'pending' ? 'Waiting for provider sign-in…' : oauth.status === 'complete' ? 'Sign-in complete.' : oauth.status === 'expired' ? 'Sign-in expired. Start a new sign-in.' : oauth.status === 'failed' ? 'Sign-in failed. Start a new sign-in.' : 'Sign-in status unavailable.'}</p>
        </div>}
      </section>
    </div>
    {error && <div className="callout provider-settings-error" role="alert">{error}</div>}
    {message && <p className="callout" role="status">{message}</p>}
  </>
}

import { useEffect, useState } from 'preact/hooks'
import { h } from 'preact'
import { api } from './state.js'
import { createFilesDiffState, isFilesTabActive, FILE_DIFF_REFRESH_MS } from '../files-state.js'

const React = { createElement: h }
const diffState = createFilesDiffState((id) => api(`/v1/sessions/${encodeURIComponent(id)}/files`))

export function Files({ sessionId, active }) {
  const [result, setResult] = useState(() => diffState.get(sessionId) || { status: 'loading' })

  useEffect(() => {
    let mounted = true
    const refresh = async (force = false) => {
      const refreshed = await diffState.refresh(sessionId, { force })
      if (mounted && refreshed.result) setResult(refreshed.result)
    }
    if (isFilesTabActive({ id: sessionId }, active ? 'files' : null)) {
      setResult(diffState.get(sessionId) || { status: 'loading' })
      void refresh()
      const timer = setInterval(() => void refresh(true), FILE_DIFF_REFRESH_MS)
      return () => { mounted = false; clearInterval(timer) }
    }
    return () => { mounted = false }
  }, [sessionId, active])

  return <FilesResult result={result}/>
}

function FilesResult({ result }) {
  if (!result || result.status === 'loading') return <div class="content-section"><div class="loading">Loading file changes...</div></div>
  if (result.status === 'unavailable') return <div class="content-section"><div class="empty"><strong>Files unavailable</strong><span>{result.message || 'The worker base revision is unavailable.'}</span></div></div>
  const diff = result.diff
  const files = diff?.files || []
  if (!files.length) return <div class="content-section"><div class="empty"><strong>No file changes</strong><span>This worker has no committed or uncommitted changes relative to its recorded base.</span></div></div>
  const additions = files.reduce((sum, file) => sum + (file.additions || 0), 0)
  const deletions = files.reduce((sum, file) => sum + (file.deletions || 0), 0)
  return <div class="content-section"><div class="section-heading"><h3>Session changes</h3><span>{files.length} files · +{additions} −{deletions}{diff.truncated ? ' · file list truncated' : ''}</span></div><div class="file-diffs">
    {files.map((file) => <article class="file-diff" key={`${file.old_path || ''}\0${file.path}`} data-file-key={`${file.old_path || ''}\0${file.path}`}><div class="file-diff-heading"><strong>{file.old_path ? `${file.old_path} → ${file.path}` : file.path}</strong><span>{file.status}</span></div>
      {file.binary ? <div class="empty"><strong>Binary file</strong><span>Binary diff content is not displayed.</span></div> : file.too_large ? <div class="empty"><strong>Diff too large</strong><span>This file's diff exceeds the display limit.</span></div> : <pre class="file-diff-content">{file.diff || 'No textual diff content.'}</pre>}
    </article>)}
  </div></div>
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character])

export function renderFilesResult(result) {
  if (!result || result.status === "loading") return `<div class="content-section"><div class="loading">Loading file changes...</div></div>`
  if (result.status === "unavailable") return `<div class="content-section"><div class="empty"><strong>Files unavailable</strong><span>${escapeHtml(result.message || "The worker base revision is unavailable.")}</span></div></div>`
  const diff = result.diff
  const files = diff?.files || []
  if (!files.length) return `<div class="content-section"><div class="empty"><strong>No file changes</strong><span>This worker has no committed or uncommitted changes relative to its recorded base.</span></div></div>`
  const additions = files.reduce((sum, file) => sum + (file.additions || 0), 0)
  const deletions = files.reduce((sum, file) => sum + (file.deletions || 0), 0)
  return `<div class="content-section"><div class="section-heading"><h3>Session changes</h3><span>${files.length} files · +${additions} −${deletions}${diff.truncated ? " · file list truncated" : ""}</span></div><div class="file-diffs">${files.map((file) => `<article class="file-diff" data-file-key="${escapeHtml(JSON.stringify([file.old_path, file.path]))}"><div class="file-diff-heading"><strong>${escapeHtml(file.old_path ? `${file.old_path} → ${file.path}` : file.path)}</strong><span>${escapeHtml(file.status)}</span></div>${file.binary ? `<div class="empty"><strong>Binary file</strong><span>Binary diff content is not displayed.</span></div>` : file.too_large ? `<div class="empty"><strong>Diff too large</strong><span>This file's diff exceeds the display limit.</span></div>` : `<pre class="file-diff-content">${escapeHtml(file.diff || "No textual diff content.")}</pre>`}</article>`).join("")}</div></div>`
}

export function updateFilesPanel(panel, result) {
  const signature = JSON.stringify(result ?? null)
  if (panel.dataset.filesDiffSignature === signature) return false
  const scrollPositions = new Map([...panel.querySelectorAll("[data-file-key]")].map((file) => [file.dataset.fileKey, file.querySelector(".file-diff-content")?.scrollTop ?? 0]))
  panel.innerHTML = renderFilesResult(result)
  panel.dataset.filesDiffSignature = signature
  for (const file of panel.querySelectorAll("[data-file-key]")) {
    const content = file.querySelector(".file-diff-content")
    if (content && scrollPositions.has(file.dataset.fileKey)) content.scrollTop = scrollPositions.get(file.dataset.fileKey)
  }
  return true
}

export const openFileExtensions = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'csv', 'tsv',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'ico', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'ogg', 'm4a'])
const referenceExtensions = /\.(?:py|js|mjs|ts|tsx|jsx|json|md|yaml|yml|txt|pdf|docx?|xlsx?|pptx?|csv|tsv|html|css|scss|go|rs|java|c|h|cpp|hpp|m|sh|bat|ps1|png|jpe?g|gif|bmp|webp|tiff?|ico|svg|mp4|mov|webm|mp3|wav|ogg|m4a|zip|gz|toml|ini|log|sql|ipynb)$/i

export function canOpenDocument(value) {
  return openFileExtensions.has(String(value).split(/[\\/]/).at(-1).split('.').at(-1).toLowerCase())
}

function localReference(value, fromLink = false) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f<>]/.test(value)) return null
  let reference = value.trim()
  if (/^file:\/\//i.test(reference)) {
    try {
      const url = new URL(reference)
      if (url.host && url.host !== 'localhost') return null
      reference = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1')
    } catch (_) { return null }
  } else if (/^\/api\/files\?/.test(reference)) {
    reference = new URLSearchParams(reference.split('?')[1]).get('path') || ''
  } else if (fromLink) {
    try { reference = decodeURIComponent(reference) } catch (_) { return null }
  }
  if (!reference || /[\x00-\x1f\x7f<>]/.test(reference)) return null
  reference = reference.replace(/:\d+(?::\d+)?$/, '')
  const absolute = /^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)/.test(reference)
  if (!absolute && (/^[A-Za-z][\w+.-]*:/.test(reference) ||
    !(/^(?:\.{1,2}[\\/]|[^\s]+[\\/])/.test(reference) || /[\\/]$/.test(reference) ||
      fromLink && /[\\/]/.test(reference) || referenceExtensions.test(reference)))) return null
  return reference
}

export function outputFileReferences(text) {
  const lines = [], references = new Map()
  let fence = null
  for (const line of String(text || '').split('\n')) {
    const opening = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      if (new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$').test(line)) fence = null
      continue
    }
    if (opening) { fence = opening[1]; continue }
    lines.push(line)
  }
  const pattern = /(`+)([^`\n]+)\1|!?\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g
  for (const match of lines.join('\n').matchAll(pattern)) {
    const value = localReference(match[2] || match[3]?.replace(/^<|>$/g, ''), !match[2])
    if (!value) continue
    const key = value.replaceAll('\\', '/').replace(/\/$/, '')
    if (!references.has(key)) references.set(key, { reference: value,
      name: value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || value,
      directoryHint: /[\\/]$/.test(value), canOpen: /[\\/]$/.test(value) || canOpenDocument(value) })
  }
  return [...references.values()]
}

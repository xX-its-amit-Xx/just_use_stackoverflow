// Safe Markdown -> HTML renderer built on vendored markdown-it (MIT).
// Slug de-duplication logic adapted from github-slugger (ISC).
import MarkdownIt from './vendor/markdown-it/index.mjs'

const UNSAFE_PROTO = /^(vbscript|javascript|file|data):/
const SAFE_DATA = /^data:image\/(gif|png|jpeg|webp);/

function isUnsafeUrl (url) {
  // Strip whitespace/control chars that browsers ignore when resolving schemes.
  const str = String(url).replace(/[\u0000- \u007f]/g, '').toLowerCase()
  if (!UNSAFE_PROTO.test(str)) return false
  return !SAFE_DATA.test(str)
}

function createParser () {
  const md = new MarkdownIt('commonmark', { html: false, xhtmlOut: true, linkify: false, typographer: false })
  md.enable(['table', 'strikethrough'])
  // Never drop links; instead replace dangerous URLs by '#'.
  md.validateLink = () => true
  const normalizeLink = md.normalizeLink.bind(md)
  md.normalizeLink = url => (isUnsafeUrl(url) ? '#' : normalizeLink(url))
  // GFM strikethrough is rendered as <del>.
  md.renderer.rules.s_open = () => '<del>'
  md.renderer.rules.s_close = () => '</del>'
  return md
}

const md = createParser()

/** Plain text of an inline token's children (inline markup removed). */
function inlineText (tokens) {
  let out = ''
  for (const t of tokens || []) {
    switch (t.type) {
      case 'text':
      case 'code_inline':
      case 'html_inline':
        out += t.content
        break
      case 'softbreak':
      case 'hardbreak':
        out += ' '
        break
      case 'image':
        out += inlineText(t.children)
        break
      default:
        if (t.children) out += inlineText(t.children)
    }
  }
  return out
}

export function slugify (text, seen) {
  let result = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N} _-]/gu, '')
    .replace(/ /g, '-')
  if (seen instanceof Map) {
    const original = result
    while (seen.has(result)) {
      const n = (seen.get(original) || 0) + 1
      seen.set(original, n)
      result = original + '-' + n
    }
    seen.set(result, 0)
  }
  return result
}

function headings (tokens) {
  const list = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'heading_open') continue
    const inline = tokens[i + 1]
    const text = inline && inline.type === 'inline' ? inlineText(inline.children) : ''
    list.push({ token: t, level: Number(t.tag.slice(1)), text })
  }
  return list
}

export function render (markdown, { headingIds = false } = {}) {
  const env = {}
  const tokens = md.parse(String(markdown ?? ''), env)
  if (headingIds) {
    const seen = new Map()
    for (const h of headings(tokens)) h.token.attrSet('id', slugify(h.text, seen))
  }
  return md.renderer.render(tokens, md.options, env)
}

export function toc (markdown) {
  const tokens = md.parse(String(markdown ?? ''), {})
  const seen = new Map()
  return headings(tokens).map(h => ({ level: h.level, text: h.text, slug: slugify(h.text, seen) }))
}

export default { render, toc, slugify }

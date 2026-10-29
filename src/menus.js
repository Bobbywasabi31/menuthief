// MenuThief M2 — menu layer. Ports the M0 pipeline's browser-viable parts:
// menu-link discovery (same ranking + delivery-platform exclusion), the
// exact M0 extraction prompt, and the M0 schema validator. Every menu
// carries provenance (source URL + fetch date + engine) per the plan.
//
// Browser reality: restaurant sites rarely send CORS headers, so page
// fetches try direct, then public CORS relays. Structuring needs an LLM —
// bring-your-own-key (OpenAI-compatible endpoint), key stays in this
// browser's localStorage. PDF menus are detected but not parsed in M2.

import solareMenu from './data/solare.js'
import starliteMenu from './data/starlite.js'
import tadokoroMenu from './data/tadokoro.js'

// Real menus captured by the M0 pipeline run (2026-10-28), bundled so the
// demo works offline. Provenance travels inside each object.
export const BUNDLED_MENUS = {
  'seed:solare': solareMenu,
  'seed:starlite': starliteMenu,
  'seed:tadokoro': tadokoroMenu, // is_menu: false — the honest no-menu case
}

// ---------------------------------------------------------------------------
// Extraction prompt — verbatim port of M0's TEXT_MENU_PROMPT (changing a
// prompt changes the experiment; keep in sync with menu_pipeline.py).
// ---------------------------------------------------------------------------

export const MENU_SCHEMA_SNIPPET = `{
  "is_menu": true,
  "sections": [
    {"name": "Section name (e.g. Starters, Mains, Desserts)",
     "items": [
       {"name": "Dish name exactly as written",
        "description": "Description exactly as written, or null if none",
        "price": 16.50}
     ]}
  ]
}`

export const TEXT_MENU_PROMPT = `You convert restaurant menu text into structured JSON.

Rules:
- Output ONLY a JSON object matching this shape, no commentary, no code fences:
${MENU_SCHEMA_SNIPPET}
- Include ONLY dishes that actually appear in the text. Never invent dishes,
  descriptions, or prices.
- "price" is a number in dollars (16.50) or null when no price is shown.
- Keep dish names and descriptions verbatim (fix only obvious line-wrap splits).
- Group items under the section headings used by the menu itself; if the menu
  has no sections, use one section named "Menu".
- If the text is NOT a restaurant menu (e.g. a homepage, an article, a
  reservation page), output {"is_menu": false, "sections": []}.
- Menus sometimes list several menus (lunch/dinner/drinks) in one document;
  include all of them, using their headings as sections.

Menu text follows:
---
{menu_text}
---`

// ---------------------------------------------------------------------------
// Validator — port of M0's validate_menu (accepts the variants extension).
// ---------------------------------------------------------------------------

export function validateMenu(obj) {
  const errors = []
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return ['top level is not an object']
  }
  if (obj.is_menu === false) return errors // an honest 'not a menu' is valid
  if (!Array.isArray(obj.sections)) return ['sections missing or not a list']
  obj.sections.forEach((sec, i) => {
    if (typeof sec?.name !== 'string' || !sec.name.trim()) {
      errors.push(`section ${i}: name missing`)
    }
    if (!Array.isArray(sec?.items)) {
      errors.push(`section ${i}: items missing`)
      return
    }
    sec.items.forEach((item, j) => {
      if (typeof item?.name !== 'string' || !item.name.trim()) {
        errors.push(`section ${i} item ${j}: name missing`)
      }
      const price = item?.price
      if (price !== null && price !== undefined && typeof price !== 'number') {
        errors.push(`section ${i} item ${j}: price not numeric/null`)
      }
      const variants = item?.variants
      if (variants !== null && variants !== undefined) {
        if (!Array.isArray(variants)) {
          errors.push(`section ${i} item ${j}: variants not a list`)
        } else {
          variants.forEach((v, k) => {
            if (typeof v?.label !== 'string' || !v.label.trim()) {
              errors.push(`section ${i} item ${j} variant ${k}: label missing`)
            }
            const vp = v?.price
            if (vp !== null && vp !== undefined && typeof vp !== 'number') {
              errors.push(`section ${i} item ${j} variant ${k}: price not numeric/null`)
            }
          })
        }
      }
      const desc = item?.description
      if (desc !== null && desc !== undefined && typeof desc !== 'string') {
        errors.push(`section ${i} item ${j}: description not string/null`)
      }
    })
  })
  return errors
}

export function countItems(menu) {
  if (!menu || menu.is_menu === false) return 0
  return (menu.sections || []).reduce((n, s) => n + (s.items?.length || 0), 0)
}

// ---------------------------------------------------------------------------
// Menu-link discovery — port of M0's menu_link_candidates + link extraction.
// ---------------------------------------------------------------------------

const MENU_LINK_HINTS = ['menu', 'menus', 'food-menu', 'dinner', 'lunch', 'brunch']
const DELIVERY_DOMAINS = ['doordash', 'ubereats', 'grubhub', 'seamless']

// Extract {href (absolute), label} pairs from an HTML string. Uses
// DOMParser in the browser; a regex fallback keeps it testable in Node.
export function extractLinks(html, baseUrl) {
  const links = []
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelectorAll('a[href]').forEach((a) => {
      try {
        links.push({
          href: new URL(a.getAttribute('href'), baseUrl).href,
          label: (a.textContent || '').trim(),
        })
      } catch { /* unparseable href */ }
    })
    return links
  }
  const re = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    try {
      links.push({
        href: new URL(m[1], baseUrl).href,
        label: m[2].replace(/<[^>]+>/g, '').trim(),
      })
    } catch { /* unparseable href */ }
  }
  return links
}

export function menuLinkCandidates(links, baseUrl) {
  const baseHost = new URL(baseUrl).host
  const scored = []
  for (const link of links) {
    const low = link.href.toLowerCase()
    const label = (link.label || '').toLowerCase()
    let host = ''
    try { host = new URL(link.href).host } catch { continue }
    if (host !== baseHost && !low.endsWith('.pdf')) continue // stay on-site
    if (DELIVERY_DOMAINS.some((bad) => low.includes(bad))) continue
    let score = 0
    if (low.endsWith('.pdf')) score += 3
    if (MENU_LINK_HINTS.some((h) => low.includes(h))) score += 2
    if (label.includes('menu')) score += 2
    if (score >= 2) scored.push({ href: link.href, label: link.label, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const seen = new Set()
  return scored.filter((c) => (seen.has(c.href) ? false : (seen.add(c.href), true)))
}

export function isPdfUrl(url) {
  return url.toLowerCase().split('?')[0].endsWith('.pdf')
}

// ---------------------------------------------------------------------------
// Page text — port of M0's cleaned-text reduction.
// ---------------------------------------------------------------------------

export function htmlToText(html) {
  let text
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelectorAll('script, style, nav, footer, header, noscript')
      .forEach((el) => el.remove())
    text = doc.body?.innerText || doc.body?.textContent || ''
  } else {
    text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, '\n')
  }
  return text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
}

// ---------------------------------------------------------------------------
// Fetching through the CORS wall. Order: direct, allorigins, corsproxy.
// ---------------------------------------------------------------------------

const RELAYS = [
  (u) => u,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
]

export async function fetchPage(url, timeoutMs = 20000) {
  const errors = []
  for (const wrap of RELAYS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(wrap(url), { signal: controller.signal })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const text = await resp.text()
      if (!text || text.length < 40) throw new Error('empty response')
      return text
    } catch (err) {
      errors.push(err.message)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error('Could not fetch the page (site unreachable or blocking): ' + errors.join(' | '))
}

// ---------------------------------------------------------------------------
// BYOK LLM settings + structuring (OpenAI-compatible chat completions).
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'menumap-llm-v1'
const CACHE_KEY = 'menumap-menu-cache-v1'

export const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
}

function storage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

export function loadSettings() {
  const raw = storage()?.getItem(SETTINGS_KEY)
  if (!raw) return { ...DEFAULT_SETTINGS }
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } } catch { return { ...DEFAULT_SETTINGS } }
}

export function saveSettings(settings) {
  storage()?.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function loadCachedMenu(placeId) {
  const raw = storage()?.getItem(CACHE_KEY)
  if (!raw) return null
  try { return JSON.parse(raw)[placeId] || null } catch { return null }
}

export function saveCachedMenu(placeId, menu) {
  const store = storage()
  if (!store) return
  let all = {}
  try { all = JSON.parse(store.getItem(CACHE_KEY) || '{}') } catch { /* fresh */ }
  all[placeId] = menu
  try { store.setItem(CACHE_KEY, JSON.stringify(all)) } catch { /* quota: skip */ }
}

export async function structureMenuText(menuText, settings, { placeName, source, sourceUrl }) {
  if (!settings.apiKey) throw new Error('NO_KEY')
  const base = settings.baseUrl.replace(/\/$/, '')
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0,
      messages: [{ role: 'user', content: TEXT_MENU_PROMPT.replace('{menu_text}', menuText.slice(0, 60000)) }],
    }),
  })
  if (!resp.ok) throw new Error(`AI endpoint returned HTTP ${resp.status}`)
  const json = await resp.json()
  const content = json.choices?.[0]?.message?.content || ''
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  let extraction
  try {
    extraction = JSON.parse(cleaned)
  } catch {
    throw new Error('The AI response was not valid JSON')
  }
  const errors = validateMenu(extraction)
  if (errors.length) throw new Error('AI output failed validation: ' + errors[0])
  return {
    place_name: placeName,
    source,
    source_url: sourceUrl,
    fetched_at: new Date().toISOString(),
    engine: `api:${settings.model}`,
    is_menu: extraction.is_menu !== false,
    sections: extraction.sections || [],
  }
}

// ---------------------------------------------------------------------------
// The full fetch flow for a place with a website. Returns one of:
//   { kind: 'menu', menu }      — structured (caller caches it)
//   { kind: 'nomenu', menu }    — site checked, no menu published
//   { kind: 'pdf', url }        — menu exists but is a PDF (not parsed in M2)
// Throws on transport failure; the UI offers retry / paste instead.
// ---------------------------------------------------------------------------

export async function fetchMenuForPlace(place, settings, onStatus = () => {}) {
  if (!place.website) throw new Error('NO_WEBSITE')
  onStatus('Reading the restaurant’s website…')
  const homeHtml = await fetchPage(place.website)
  const candidates = menuLinkCandidates(extractLinks(homeHtml, place.website), place.website)

  // A homepage that is itself the menu (common for one-page sites): try it
  // when no better candidate exists.
  const target = candidates[0]?.href || null
  if (target && isPdfUrl(target)) return { kind: 'pdf', url: target }

  let text
  let sourceUrl
  if (target) {
    onStatus('Found a menu page — reading it…')
    text = htmlToText(await fetchPage(target))
    sourceUrl = target
  } else {
    text = htmlToText(homeHtml)
    sourceUrl = place.website
  }

  onStatus('Structuring the menu with your AI key…')
  const menu = await structureMenuText(text, settings, {
    placeName: place.name, source: 'website', sourceUrl,
  })
  return menu.is_menu ? { kind: 'menu', menu } : { kind: 'nomenu', menu }
}

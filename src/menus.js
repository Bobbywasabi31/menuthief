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

// A PDF only counts as the menu fallback when it actually looks like one
// (menu in the file name or the link text). Real sites link plenty of
// other PDFs — Hodad's jukebox song list, an industry marketing code —
// and presenting those as "the menu" would be a false claim.
export function pickPdfFallback(candidates) {
  const pdf = (candidates || []).find(
    (c) => isPdfUrl(c.href) && (/menu/i.test(c.href) || /menu/i.test(c.label || '')))
  return pdf?.href || null
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
// Heuristic parser — the no-key menu puller (added v1.2.0 at Alex's
// request: "add menu pulling from the websites"). Reads cleaned page text
// and extracts sections / dishes / prices with layout rules instead of an
// LLM. Rougher than the AI path — prices can land on the wrong line on
// exotic layouts — so its menus are labeled engine:'heuristic' and the UI
// says so. Guarded by a confidence rule so homepages don't become "menus":
// at least 3 priced dishes, or 6+ dishes with a named section and a price.
// ---------------------------------------------------------------------------

const SKIP_LINE_RES = [
  /^(home|about|contact|reservations?|order online|order now|book now|call now|view menu|see (the )?menu|learn more|get started|limited time item|\(opens in a new tab\))$/i,
  /^(home|about|contact|reservations?|order online|gift cards?|private (events|dining)|catering|careers|press|gallery|events?)$/i,
  /\b(opening hours|hours of operation|find us|get directions|book a table|sign up|newsletter|all rights reserved)\b/i,
  /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b.*\b(am|pm)\b/i,
  /\d{3}[-.\s]\d{3}[-.\s]\d{4}/, // phone numbers
  /^(www\.|https?:)/i,
]

function isSkipLine(line) {
  return SKIP_LINE_RES.some((re) => re.test(line))
}

// Split "Grilled Salmon $24.50" / "Grilled Salmon .... 24" into name+price.
// Returns null when the trailing number is not a plausible menu price
// (years, street numbers, counts) — menus are never detected by $ alone.
export function splitPrice(line) {
  const m = line.match(/^(.*?)[\s.…·_—–-]*\$?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*$/)
  if (!m) return null
  const name = m[1].replace(/[\s.…·_—–-]+$/, '').trim()
  const token = m[2].replace(/,/g, '')
  const value = Number(token)
  if (!name || name.length < 2) return null
  if (/\d$/.test(name)) return null // we split a longer number in half
  if (!line.includes('$') && !token.includes('.') && token.length > 2) return null
  if (!(value >= 1 && value <= 500)) return null
  return { name, price: value }
}

// A price alone on a line, allowing the decorations real sites wrap it in
// ("- 16", "- 16 |", "$14"). Four-digit years can't match (\d{1,3} + anchor).
const STANDALONE_PRICE_RE = /^[.\s•·-]*\$?\s*(\d{1,3}(?:\.\d{2})?)\s*[.|·•\s-]*$/
const MARKET_PRICE_RE = /^(.*?)[\s.…·_—–-]*(market price|mp)\s*$/i

function isCapsHeader(line) {
  return line.length >= 3 && line.length <= 44
    && /[A-Z]/.test(line) && line === line.toUpperCase()
    && !line.endsWith('.') && !line.endsWith(',')
    && line.split(/\s+/).length <= 6
    && !/\d{4}/.test(line)
}

function isTitleHeader(lines, i) {
  const line = lines[i]
  if (line.length < 3 || line.length > 40) return false
  if (line.split(/\s+/).length > 5) return false
  if (line.endsWith('.') || line.endsWith(',')) return false
  if (!/^[\p{Lu}]/u.test(line)) return false
  if (/[a-z]{3,}/.test(line.slice(1)) && line !== line.toUpperCase()) {
    // Title Case: every word capitalised
    if (!line.split(/\s+/).every((w) => /^[\p{Lu}0-9'&-]/u.test(w))) return false
  }
  // A header is only a header if what follows looks like a dish.
  const next = lines[i + 1] || ''
  return Boolean(splitPrice(next)) || STANDALONE_PRICE_RE.test(lines[i + 2] || '')
}

export function parseMenuHeuristic(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const sections = [{ name: 'Menu', items: [] }]
  let current = sections[0]
  let pendingName = null

  const pushItem = (item) => {
    const dup = current.items.some(
      (it) => it.name.toLowerCase() === item.name.toLowerCase() && it.price === item.price)
    if (!dup) current.items.push(item)
  }

  // Collect up to 3 description lines following index i; returns [desc, used].
  const collectDesc = (i) => {
    const parts = []
    let j = i
    while (j < lines.length && parts.length < 3) {
      const l = lines[j]
      if (isSkipLine(l) || splitPrice(l) || STANDALONE_PRICE_RE.test(l)) break
      if (MARKET_PRICE_RE.test(l) && l.length > 12) break // next dish (market price)
      if (isCapsHeader(l)) break
      if (l.length > 210) break
      // A line followed by a standalone price is a dish name, not prose.
      if (STANDALONE_PRICE_RE.test(lines[j + 1] || '')) break
      // A short name-like line followed by a longer plain line starts the
      // next priceless dish (name + description), not more description.
      const after = lines[j + 1] || ''
      if (l.length <= 64 && l.split(/\s+/).length <= 7 && /^[\p{Lu}]/u.test(l)
        && !/[.,;:]$/.test(l)
        && after.length > l.length && after.length <= 210
        && !splitPrice(after) && !isCapsHeader(after)) break
      parts.push(l)
      j++
      if (parts.join(' ').length > 240) break
    }
    return [parts.length ? parts.join(' ') : null, j - i]
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isSkipLine(line)) { i++; continue }

    // Price on its own line completes a pending dish name.
    const solo = line.match(STANDALONE_PRICE_RE)
    if (solo && pendingName) {
      const [desc, used] = collectDesc(i + 1)
      pushItem({ name: pendingName, description: desc, price: Number(solo[1]) })
      pendingName = null
      i += 1 + used
      continue
    }
    if (solo) { i++; continue } // stray price with no dish: ignore

    // "Name ....... $24" / "Name 24.50" / "Name — market price"
    const mp = line.match(MARKET_PRICE_RE)
    const priced = splitPrice(line)
    if (priced || (mp && mp[1].trim().length >= 2)) {
      const name = (priced ? priced.name : mp[1].replace(/[\s.…·_—–-]+$/, '').trim())
      const [desc, used] = collectDesc(i + 1)
      pushItem({ name, description: desc, price: priced ? priced.price : null })
      pendingName = null
      i += 1 + used
      continue
    }

    // A caps line whose price sits on the next line is a dish, not a
    // header ("POBLANO CALI" / "- 17" on Lucha Libre's real menu page).
    if (isCapsHeader(line) && STANDALONE_PRICE_RE.test(lines[i + 1] || '')) {
      pendingName = line
      i++
      continue
    }

    // Section headers (caps, or title-case with a dish right after).
    if (isCapsHeader(line) || isTitleHeader(lines, i)) {
      const name = line.replace(/\s+/g, ' ')
      if (!sections.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
        current = { name, items: [] }
        sections.push(current)
      } else {
        current = sections.find((s) => s.name.toLowerCase() === name.toLowerCase())
      }
      pendingName = null
      i++
      continue
    }

    // Dish name whose price sits on the next line.
    if (line.length <= 70 && STANDALONE_PRICE_RE.test(lines[i + 1] || '')) {
      pendingName = line
      i++
      continue
    }

    // Priceless dish (name line + longer description line), only once the
    // current section already has a priced dish anchoring it as menu-like.
    const next = lines[i + 1] || ''
    if (line.length <= 64 && next.length > line.length && next.length <= 210
      && !splitPrice(next) && !isCapsHeader(next) && !isSkipLine(next)
      && current.items.some((it) => it.price !== null)) {
      pushItem({ name: line, description: next, price: null })
      i += 2
      continue
    }

    i++
  }

  const kept = sections.filter((s) => s.items.length > 0)
  const all = kept.flatMap((s) => s.items)
  const pricedCount = all.filter((it) => it.price !== null).length
  const namedSections = kept.filter((s) => s.name !== 'Menu').length
  const isMenu = pricedCount >= 3 || (all.length >= 6 && pricedCount >= 1 && namedSections >= 1)
  return { is_menu: isMenu, sections: isMenu ? kept : [] }
}

// Structure already-fetched text: the user's AI key when one is saved
// (best quality), otherwise the built-in heuristic puller — pulling menus
// from websites must not require a key. LLM transport/validation failures
// also fall back to the heuristic before giving up.
export async function structureFromText(text, settings, { placeName, source, sourceUrl }) {
  if (settings.apiKey) {
    try {
      return await structureMenuText(text, settings, { placeName, source, sourceUrl })
    } catch (err) {
      if (err.message === 'NO_KEY') throw err
      // fall through to the heuristic
    }
  }
  const parsed = parseMenuHeuristic(text)
  return {
    place_name: placeName,
    source,
    source_url: sourceUrl,
    fetched_at: new Date().toISOString(),
    engine: 'heuristic',
    is_menu: parsed.is_menu,
    sections: parsed.sections,
  }
}

// ---------------------------------------------------------------------------
// The full fetch flow for a place with a website. Discovers the menu page
// from the homepage's links, probes the common menu paths when no link is
// published, then structures the page: AI key if saved, else the built-in
// heuristic puller. Returns one of:
//   { kind: 'menu', menu }      — structured (caller caches it)
//   { kind: 'nomenu', menu }    — site checked, no readable menu there
//   { kind: 'pdf', url }        — menu exists but is a PDF (not parsed yet)
// Throws on transport failure; the UI offers retry / paste instead.
// ---------------------------------------------------------------------------

const FAST_RELAYS = [RELAYS[0], RELAYS[1]] // direct, then allorigins

async function fetchPageFast(url, timeoutMs = 9000) {
  for (const wrap of FAST_RELAYS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(wrap(url), { signal: controller.signal })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const text = await resp.text()
      if (!text || text.length < 40) throw new Error('empty response')
      return text
    } catch { /* try the next relay */ } finally {
      clearTimeout(timer)
    }
  }
  throw new Error('unreachable')
}

const MENU_PATH_PROBES = ['/menu', '/menus', '/menu.html', '/food-menu', '/dinner-menu', '/lunch-menu', '/eat']

export async function fetchMenuForPlace(place, settings, onStatus = () => {}) {
  if (!place.website) throw new Error('NO_WEBSITE')
  onStatus('Reading the restaurant’s website…')
  const homeHtml = await fetchPage(place.website)
  if (homeHtml.startsWith('%PDF')) return { kind: 'pdf', url: place.website }
  const candidates = menuLinkCandidates(extractLinks(homeHtml, place.website), place.website)

  // HTML menu pages are tried BEFORE any PDF candidate. The M0 ranking
  // gives PDFs a bonus (a PDF is often the menu — Solare), but real-site
  // data (2026-10-31) showed stray PDFs winning by that bonus: Stone
  // Brewing's homepage links an industry marketing-code PDF and Hodad's
  // a jukebox song list, both ranked above their actual menu pages.
  // So a menu-like PDF (pickPdfFallback) is remembered, not taken on sight.
  let pdfFallback = pickPdfFallback(candidates)
  const pages = candidates.filter((c) => !isPdfUrl(c.href)).slice(0, 2).map((c) => c.href)

  for (const url of pages) {
    let html
    try {
      onStatus('Found a menu page — reading it…')
      html = await fetchPage(url)
    } catch { continue }
    if (html.startsWith('%PDF')) { if (/menu/i.test(url)) pdfFallback = pdfFallback || url; continue }
    onStatus(settings.apiKey ? 'Structuring the menu with your AI key…' : 'Pulling the menu from the website…')
    const menu = await structureFromText(htmlToText(html), settings, {
      placeName: place.name, source: 'website', sourceUrl: url,
    })
    if (menu.is_menu) return { kind: 'menu', menu }
  }

  // No published menu link panned out — probe the paths restaurants
  // almost always use, in case the menu page just isn't linked.
  const origin = new URL(place.website).origin
  for (const path of MENU_PATH_PROBES) {
    const url = origin + path
    if (pages.includes(url)) continue
    let html
    try {
      onStatus(`Checking ${path} for a menu…`)
      html = await fetchPageFast(url)
    } catch { continue }
    if (html.startsWith('%PDF')) { if (/menu/i.test(url)) pdfFallback = pdfFallback || url; continue }
    const linked = menuLinkCandidates(extractLinks(html, url), url)
    if (!pdfFallback) pdfFallback = pickPdfFallback(linked)
    const menu = await structureFromText(htmlToText(html), settings, {
      placeName: place.name, source: 'website', sourceUrl: url,
    })
    if (menu.is_menu) return { kind: 'menu', menu }
  }

  // Finally, the homepage's own text (one-page sites).
  onStatus(settings.apiKey ? 'Structuring the menu with your AI key…' : 'Pulling the menu from the website…')
  const menu = await structureFromText(htmlToText(homeHtml), settings, {
    placeName: place.name, source: 'website', sourceUrl: place.website,
  })
  if (menu.is_menu) return { kind: 'menu', menu }
  if (pdfFallback) return { kind: 'pdf', url: pdfFallback }
  return { kind: 'nomenu', menu }
}

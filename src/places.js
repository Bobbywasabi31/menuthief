// MenuThief data layer — food places from OpenStreetMap via Overpass.
// Live-first: tries public Overpass endpoints in rotation with a timeout.
// If every endpoint is unreachable, the caller falls back to SEED_PLACES and
// must say so in the UI (never present seed data as live).

export const CATEGORIES = [
  { key: 'restaurant', label: 'Restaurants', emoji: '🍽️', color: '#b3392e' },
  { key: 'cafe', label: 'Cafés', emoji: '☕', color: '#8a5a2b' },
  { key: 'fastfood', label: 'Fast food', emoji: '🍔', color: '#e07b39' },
  { key: 'bakery', label: 'Bakeries', emoji: '🥐', color: '#c9a227' },
  { key: 'bar', label: 'Bars & pubs', emoji: '🍸', color: '#5b6abf' },
  { key: 'dessert', label: 'Dessert', emoji: '🍦', color: '#d1608c' },
]

const AMENITY_TO_CATEGORY = {
  restaurant: 'restaurant',
  food_court: 'restaurant',
  cafe: 'cafe',
  fast_food: 'fastfood',
  bar: 'bar',
  pub: 'bar',
  biergarten: 'bar',
  ice_cream: 'dessert',
}

export function categoryOf(tags) {
  if (tags.shop === 'bakery') return 'bakery'
  return AMENITY_TO_CATEGORY[tags.amenity] || 'restaurant'
}

export function categoryMeta(key) {
  return CATEGORIES.find((c) => c.key === key) || CATEGORIES[0]
}

const AMENITY_REGEX =
  '^(restaurant|cafe|fast_food|food_court|bar|pub|biergarten|ice_cream)$'

export function buildQuery(bounds) {
  const { south, west, north, east } = bounds
  const bbox = `${south},${west},${north},${east}`
  // `out tags center` = tags + coordinates only (no way geometry), the
  // smallest payload that still pins every place.
  return `[out:json][timeout:20];
(
  node["amenity"~"${AMENITY_REGEX}"](${bbox});
  way["amenity"~"${AMENITY_REGEX}"](${bbox});
  node["shop"="bakery"](${bbox});
  way["shop"="bakery"](${bbox});
);
out tags center 300;`
}

// Public Overpass mirrors, RACED in parallel (see fetchPlaces).
// openstreetmap.fr was dropped 2026-10-31: it now 403s non-whitelisted
// usage, so it only ever burned a serial timeout.
export const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

function normalizeElement(el) {
  const tags = el.tags || {}
  if (!tags.name) return null // an unnamed pin is useless in this app
  const lat = el.lat ?? el.center?.lat
  const lon = el.lon ?? el.center?.lon
  if (lat == null || lon == null) return null
  const addressParts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:city'],
  ].filter(Boolean)
  return {
    id: `osm:${el.type}/${el.id}`,
    name: tags.name,
    lat,
    lon,
    category: categoryOf(tags),
    cuisine: tags.cuisine ? tags.cuisine.replaceAll(';', ', ').replaceAll('_', ' ') : null,
    address: addressParts.length ? addressParts.join(', ') : null,
    openingHours: tags.opening_hours || null,
    website: tags.website || tags['contact:website'] || null,
    phone: tags.phone || tags['contact:phone'] || null,
    source: 'live',
  }
}

async function fetchFromEndpoint(endpoint, query, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const json = await resp.json()
    return (json.elements || []).map(normalizeElement).filter(Boolean)
  } finally {
    clearTimeout(timer)
  }
}

// Races every endpoint in parallel and takes the first good answer.
// Why: serial fallback burned a full timeout per dead/slow mirror
// before trying the next — on Alex's phone (2026-10-31) the public
// instances queued long enough that the app sat on "Loading…" with no
// pins at all. With a race, a hanging mirror costs nothing.
// Throws only if ALL endpoints fail.
export async function fetchPlaces(bounds, timeoutMs = 20000) {
  const query = buildQuery(bounds)
  try {
    return await Promise.any(ENDPOINTS.map((ep) => fetchFromEndpoint(ep, query, timeoutMs)))
  } catch (err) {
    const reasons = (err.errors || []).map((e) => e.message).join(' | ')
    throw new Error('All Overpass endpoints failed: ' + (reasons || err.message))
  }
}

// Last-good-places cache (~1 km grid cells). The app paints cached pins
// instantly on open and refreshes in the background, so a slow Overpass
// never leaves a blank map. Only ever written from a successful live
// fetch, so cached data is real data — just possibly a few days old.
const PLACES_CACHE_KEY = 'menumap-places-cache-v1'

function cacheCell(bounds) {
  const r = (v) => Math.round(v * 100) / 100
  return `${r(bounds.south)},${r(bounds.west)},${r(bounds.north)},${r(bounds.east)}`
}

export function readPlacesCache(bounds) {
  try {
    const all = JSON.parse(localStorage.getItem(PLACES_CACHE_KEY) || '{}')
    return all[cacheCell(bounds)]?.places || null
  } catch {
    return null
  }
}

export function writePlacesCache(bounds, places) {
  try {
    const all = JSON.parse(localStorage.getItem(PLACES_CACHE_KEY) || '{}')
    all[cacheCell(bounds)] = { savedAt: Date.now(), places }
    // keep only the 8 most recent cells
    const cells = Object.entries(all).sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0))
    localStorage.setItem(PLACES_CACHE_KEY, JSON.stringify(Object.fromEntries(cells.slice(0, 8))))
  } catch { /* storage full/blocked — cache is best-effort */ }
}

// Fallback demo data — real places, coordinates verified from their public
// listings during the M0 test work (Oct 2026). Shown ONLY with a visible
// "sample data" notice when live Overpass is unreachable.
export const SEED_PLACES = [
  {
    id: 'seed:solare', name: 'Solare Ristorante', lat: 32.737459, lon: -117.214095,
    category: 'restaurant', cuisine: 'italian', address: '2820 Roosevelt Rd, San Diego',
    openingHours: null, website: 'https://solarelounge.com/', phone: null, source: 'seed',
  },
  {
    id: 'seed:starlite', name: 'Starlite', lat: 32.736421, lon: -117.175026,
    category: 'bar', cuisine: 'american', address: '3175 India St, San Diego',
    openingHours: null, website: 'https://www.starlitesd.com/', phone: null, source: 'seed',
  },
  {
    id: 'seed:tadokoro', name: 'Sushi Tadokoro', lat: 32.748422, lon: -117.191506,
    category: 'restaurant', cuisine: 'sushi', address: '2244 San Diego Ave, San Diego',
    openingHours: null, website: 'http://sushitadokoro.com/', phone: null, source: 'seed',
  },
  {
    id: 'seed:pga', name: 'PGA Tour Grill', lat: 32.731994, lon: -117.203821,
    category: 'restaurant', cuisine: 'american', address: '3225 N Harbor Dr, San Diego (Airport T2)',
    openingHours: null, website: null, phone: null, source: 'seed',
  },
]

// Logic checks for the M1 data layer (run: node test-places.mjs)
import {
  CATEGORIES, SEED_PLACES, buildQuery, categoryOf, fetchPlaces,
  readPlacesCache, writePlacesCache, ENDPOINTS,
} from './src/places.js'

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

// Query shape
const q = buildQuery({ south: 32.72, west: -117.22, north: 32.755, east: -117.16 })
check('query targets the given bbox', q.includes('(32.72,-117.22,32.755,-117.16)'))
check('query includes restaurants + cafes + bakeries',
  q.includes('restaurant') && q.includes('cafe') && q.includes('"shop"="bakery"'))
check('query asks for tags+centers (ways need centers for pins)', q.includes('out tags center'))
check('dead whitelist-only mirror is gone', !ENDPOINTS.some((e) => e.includes('openstreetmap.fr')))
check('at least 4 mirrors to race', ENDPOINTS.length >= 4)

// Places cache: paint-last-good-data helpers round-trip per grid cell.
{
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  }
  const b = { south: 32.85, west: -117.2, north: 32.86, east: -117.19 }
  const fake = [{ id: 'osm:node/1', name: 'Cached Cafe', lat: 32.855, lon: -117.195, category: 'cafe' }]
  check('cache starts empty', readPlacesCache(b) === null)
  writePlacesCache(b, fake)
  check('cache round-trips', JSON.stringify(readPlacesCache(b)) === JSON.stringify(fake))
  check('cache misses a different cell', readPlacesCache({ south: 33.1, west: -117.3, north: 33.2, east: -117.2 }) === null)
  delete globalThis.localStorage
  check('cache helpers survive missing localStorage', readPlacesCache(b) === null)
}

// Category mapping
check('restaurant -> restaurant', categoryOf({ amenity: 'restaurant' }) === 'restaurant')
check('cafe -> cafe', categoryOf({ amenity: 'cafe' }) === 'cafe')
check('fast_food -> fastfood', categoryOf({ amenity: 'fast_food' }) === 'fastfood')
check('pub -> bar', categoryOf({ amenity: 'pub' }) === 'bar')
check('ice_cream -> dessert', categoryOf({ amenity: 'ice_cream' }) === 'dessert')
check('shop=bakery -> bakery', categoryOf({ shop: 'bakery' }) === 'bakery')
check('every category has label+emoji', CATEGORIES.every((c) => c.label && c.emoji && c.color))

// Seed fallback integrity
check('seed set is non-empty and fully formed', SEED_PLACES.length >= 3 && SEED_PLACES.every(
  (p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.category))
check('seed places are marked as seed (never passed off as live)',
  SEED_PLACES.every((p) => p.source === 'seed'))

// Failure path: with a 1.5s per-endpoint timeout, fetchPlaces must reject
// (Overpass is unreachable from the build VM) rather than hang or fake data.
const t0 = Date.now()
try {
  await fetchPlaces({ south: 32.72, west: -117.22, north: 32.755, east: -117.16 }, 1500)
  console.log('NOTE  fetchPlaces unexpectedly succeeded (live Overpass reachable?)')
} catch (err) {
  check(`fetchPlaces rejects when endpoints fail (${Date.now() - t0}ms)`,
    /All Overpass endpoints failed/.test(err.message))
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures ? 1 : 0)

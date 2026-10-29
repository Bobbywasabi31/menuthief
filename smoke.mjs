// Headless-Chrome smoke test for the M1 build (run: node smoke.mjs)
// Loads the served single-file app, waits for pins (live or seed fallback),
// clicks a pin, exercises a filter chip, and screenshots each stage.
import puppeteer from 'puppeteer'

const URL = 'http://127.0.0.1:8321/index.html'
const shot = (n) => `smoke-${n}.png`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const launchArgs = ['--no-sandbox', '--disable-dev-shm-usage']
// Optional: on a network where Chrome needs a proxy (e.g. a restricted
// build VM), set MENUTHIEF_PROXY=http://127.0.0.1:18080. Loopback stays direct.
if (process.env.MENUTHIEF_PROXY) {
  launchArgs.push(`--proxy-server=${process.env.MENUTHIEF_PROXY}`)
  launchArgs.push('--proxy-bypass-list=127.0.0.1;localhost')
}
const browser = await puppeteer.launch({ headless: 'new', args: launchArgs })
const page = await browser.newPage()
await page.setViewport({ width: 420, height: 880, deviceScaleFactor: 2 })

const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })

const header = await page.$eval('.brand', (el) => el.textContent).catch(() => null)
const chips = await page.$$eval('.chip', (els) => els.map((e) => e.textContent.trim()))
console.log('header:', header)
console.log('chips:', JSON.stringify(chips))

await page.screenshot({ path: shot('1-loading') })

// Wait for pins (live Overpass or seed fallback after endpoint failures)
let state = null
for (let i = 0; i < 60; i++) {
  state = await page.evaluate(() => ({
    markers: document.querySelectorAll('.leaflet-marker-icon').length,
    pill: document.querySelector('.status-pill')?.textContent?.trim() ?? null,
    notice: document.querySelector('.notice')?.textContent?.trim() ?? null,
    tiles: document.querySelectorAll('.leaflet-tile-loaded').length,
  }))
  if (state.markers > 0) break
  await sleep(2000)
}
console.log('map state:', JSON.stringify(state))
await page.screenshot({ path: shot('2-pins') })

// Click the first pin -> place card
if (state.markers > 0) {
  await page.click('.leaflet-marker-icon')
  await sleep(800)
  const card = await page.evaluate(() => {
    const el = document.querySelector('.sheet')
    return el ? el.innerText.replace(/\n+/g, ' | ') : null
  })
  console.log('place card:', card)
  await page.screenshot({ path: shot('3-card') })
}

// Filter: Bars & pubs, then back to All food
const clickChip = async (label) => {
  const handles = await page.$$('.chip')
  for (const h of handles) {
    const t = await h.evaluate((e) => e.textContent)
    if (t.includes(label)) { await h.click(); return true }
  }
  return false
}
await clickChip('Bars & pubs')
await sleep(800)
const barCount = await page.evaluate(() =>
  document.querySelectorAll('.leaflet-marker-icon').length)
console.log('markers after Bars & pubs filter:', barCount)
await page.screenshot({ path: shot('4-filtered') })

await clickChip('All food')
await sleep(800)
const allCount = await page.evaluate(() =>
  document.querySelectorAll('.leaflet-marker-icon').length)
console.log('markers after All food reset:', allCount)

console.log('js errors:', errors.length ? JSON.stringify(errors) : 'none')
await browser.close()

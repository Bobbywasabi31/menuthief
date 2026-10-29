// Headless-Chrome smoke test for the M2 build (run: node smoke2.mjs)
// Exercises: bundled menus (Solare 85 items, Starlite 49), the honest
// no-menu state (Tadokoro), the no-website idle + paste states (PGA),
// and the BYOK settings dialog persistence.
import puppeteer from 'puppeteer'

const URL = 'http://127.0.0.1:8321/index.html'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage',
    ...(process.env.MENUTHIEF_PROXY
      ? [`--proxy-server=${process.env.MENUTHIEF_PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost']
      : [])],
})
const page = await browser.newPage()
await page.setViewport({ width: 420, height: 880, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })

// Wait for the seed fallback pins
for (let i = 0; i < 60; i++) {
  const n = await page.evaluate(() =>
    document.querySelectorAll('.leaflet-marker-icon').length)
  if (n >= 4) break
  await sleep(2000)
}

async function selectPlace(name) {
  const markers = await page.$$('.leaflet-marker-icon')
  for (const m of markers) {
    await m.click()
    await sleep(400)
    const shown = await page.$eval('.sheet-name', (el) => el.textContent).catch(() => '')
    if (shown === name) return true
  }
  return false
}

async function openMenu() {
  const buttons = await page.$$('.sheet-actions .btn')
  for (const b of buttons) {
    const t = await b.evaluate((e) => e.textContent)
    if (t.includes('View menu')) { await b.click(); await sleep(600); return true }
  }
  return false
}

const menuStats = () => page.evaluate(() => ({
  items: document.querySelectorAll('.menu-item').length,
  sections: document.querySelectorAll('.menu-section').length,
  meta: document.querySelector('.menu-meta')?.textContent?.trim() ?? '',
  stateText: document.querySelector('.menu-state')?.innerText?.replace(/\n+/g, ' | ') ?? '',
}))

// --- Solare: bundled full menu ---
check('Solare selectable', await selectPlace('Solare Ristorante'))
check('menu opens', await openMenu())
let s = await menuStats()
check(`Solare menu renders 85 items (got ${s.items})`, s.items === 85)
check(`Solare menu renders 16 sections (got ${s.sections})`, s.sections === 16)
check('provenance line shows dish count', s.meta.includes('85 dishes'))
await page.screenshot({ path: 'smoke2-1-solare-menu.png' })
await page.click('.sheet-close'); await sleep(400)

// --- Starlite: bundled menu from a photo ---
check('Starlite selectable', await selectPlace('Starlite'))
await openMenu()
s = await menuStats()
check(`Starlite menu renders 49 items (got ${s.items})`, s.items === 49)
await page.screenshot({ path: 'smoke2-2-starlite-menu.png' })
await page.click('.sheet-close'); await sleep(400)

// --- Tadokoro: honest no-menu state ---
check('Tadokoro selectable', await selectPlace('Sushi Tadokoro'))
await openMenu()
s = await menuStats()
check('Tadokoro shows the no-menu state', s.stateText.includes('No published menu found'))
check('Tadokoro no-menu state explains the check', s.stateText.includes('Checked'))
await page.screenshot({ path: 'smoke2-3-tadokoro.png' })
await page.click('.sheet-close'); await sleep(400)

// --- PGA Tour Grill: no website -> idle + paste ---
check('PGA selectable', await selectPlace('PGA Tour Grill'))
await openMenu()
s = await menuStats()
check('PGA shows the not-loaded state', s.stateText.includes('No menu loaded'))
check('PGA offers paste (no website to fetch)', s.stateText.includes('Paste menu text'))
const pasteBtn = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.menu-state .btn')]
    .find((e) => e.textContent.includes('Paste menu text'))
  if (b) { b.click(); return true }
  return false
})
check('paste view opens', pasteBtn)
await sleep(400)
const hasTextarea = await page.$('.paste-box') !== null
check('paste textarea renders', hasTextarea)
await page.screenshot({ path: 'smoke2-4-pga-paste.png' })
await page.click('.sheet-close'); await sleep(400)

// --- Settings dialog persists the key locally ---
await page.click('button[aria-label="AI settings"]')
await sleep(400)
await page.type('.modal input[type="password"]', 'sk-test-123')
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.modal .btn')].find((e) => e.textContent === 'Done')
  b?.click()
})
await sleep(300)
const saved = await page.evaluate(() => localStorage.getItem('menumap-llm-v1') || '')
check('settings persist to localStorage', saved.includes('sk-test-123'))
await page.screenshot({ path: 'smoke2-5-settings.png' })

check('no page errors', errors.length === 0)
if (errors.length) console.log('errors:', JSON.stringify(errors))
await browser.close()
console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} SMOKE CHECK(S) FAILED`)
process.exit(failures ? 1 : 0)

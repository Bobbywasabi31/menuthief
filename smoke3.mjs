// Headless-Chrome smoke test for M3 (run: node smoke3.mjs)
// Tap a dish -> bundled home recipe, servings scaling, second bundled
// recipe (Starlite Burger), and the no-key generate/error path.
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
await browser.defaultBrowserContext().overridePermissions(
  'http://127.0.0.1:8321', ['clipboard-read', 'clipboard-write'])
const page = await browser.newPage()
await page.setViewport({ width: 420, height: 880, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
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

async function openMenuView() {
  const buttons = await page.$$('.sheet-actions .btn')
  for (const b of buttons) {
    const t = await b.evaluate((e) => e.textContent)
    if (t.includes('View menu')) { await b.click(); await sleep(600); return true }
  }
  return false
}

// Click the recipe button inside the menu item whose name contains `text`.
async function tapDishRecipe(text) {
  return page.evaluate((needle) => {
    const items = [...document.querySelectorAll('.menu-item')]
    const item = items.find((el) =>
      el.querySelector('.menu-item-name')?.textContent.includes(needle))
    if (!item) return false
    item.querySelector('.recipe-btn')?.click()
    return true
  }, text)
}

// --- Solare: Fettuccine all'Aragosta bundled recipe ---
check('Solare selectable', await selectPlace('Solare Ristorante'))
check('menu opens', await openMenuView())
check('tap Aragosta recipe', await tapDishRecipe("all'Aragosta"))
await sleep(600)
let stats = await page.evaluate(() => ({
  title: document.querySelector('.recipe-title')?.textContent ?? '',
  disclaimer: document.querySelector('.recipe-disclaimer')?.textContent ?? '',
  ings: document.querySelectorAll('.recipe-ings li').length,
  steps: document.querySelectorAll('.recipe-steps li').length,
  meta: [...document.querySelectorAll('.recipe-meta span')].map((e) => e.textContent).join(' · '),
  firstQty: document.querySelector('.recipe-ings li .recipe-qty')?.textContent?.trim() ?? '',
}))
check('recipe title is the dish', stats.title.includes('Aragosta'))
check('disclaimer frames it as a home version', stats.disclaimer.includes('Home version inspired by'))
check(`12 ingredients render (got ${stats.ings})`, stats.ings === 12)
check(`9 steps render (got ${stats.steps})`, stats.steps === 9)
check('meta shows Serves 2', stats.meta.includes('Serves 2'))
check(`first ingredient starts at qty 2 (got "${stats.firstQty}")`, stats.firstQty.startsWith('2'))
await page.screenshot({ path: 'smoke3-1-aragosta.png' })

// --- Servings scaling 2x ---
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.scale-btn')].find((e) => e.textContent === '2×')
  b?.click()
})
await sleep(300)
stats = await page.evaluate(() => ({
  meta: [...document.querySelectorAll('.recipe-meta span')].map((e) => e.textContent).join(' · '),
  firstQty: document.querySelector('.recipe-ings li .recipe-qty')?.textContent?.trim() ?? '',
}))
check('2x scale shows Serves 4', stats.meta.includes('Serves 4'))
check(`2x scale doubles first qty to 4 (got "${stats.firstQty}")`, stats.firstQty.startsWith('4'))
await page.screenshot({ path: 'smoke3-2-scaled.png' })

// --- Copy recipe ---
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.scale-row .btn')].find((e) => e.textContent.includes('Copy'))
  b?.click()
})
await sleep(500)
const copiedLabel = await page.evaluate(() =>
  [...document.querySelectorAll('.scale-row .btn')].map((e) => e.textContent).join(' '))
check('copy button confirms', copiedLabel.includes('Copied'))

// --- Back to menu, pick a non-bundled dish (no key -> error path) ---
await page.evaluate(() => document.querySelector('.menu-back')?.click())
await sleep(500)
check('tap Panna Cotta recipe', await tapDishRecipe('Panna Cotta'))
await sleep(500)
let stateText = await page.$eval('.menu-state', (el) => el.innerText).catch(() => '')
check('non-bundled dish offers generation', stateText.includes('Write the home recipe'))
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.menu-state .btn')].find((e) => e.textContent.includes('Write the home recipe'))
  b?.click()
})
await sleep(500)
stateText = await page.$eval('.menu-state', (el) => el.innerText).catch(() => '')
check('no key -> honest error pointing at settings', stateText.includes('AI key'))
await page.screenshot({ path: 'smoke3-3-nokey.png' })
await page.click('.sheet-close'); await sleep(400)

// --- Starlite Burger bundled recipe ---
check('Starlite selectable', await selectPlace('Starlite'))
await openMenuView()
check('tap Starlite Burger recipe', await tapDishRecipe('Starlite Burger'))
await sleep(600)
stats = await page.evaluate(() => ({
  title: document.querySelector('.recipe-title')?.textContent ?? '',
  steps: document.querySelectorAll('.recipe-steps li').length,
  tips: document.querySelectorAll('.recipe-tips li').length,
}))
check('burger recipe renders', stats.title.includes('Starlite Burger') && stats.steps === 7 && stats.tips === 3)
await page.screenshot({ path: 'smoke3-4-burger.png' })

check('no page errors', errors.length === 0)
if (errors.length) console.log('errors:', JSON.stringify(errors))
await browser.close()
console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} SMOKE CHECK(S) FAILED`)
process.exit(failures ? 1 : 0)

// Logic checks for the M2 menu layer (run: node test-menus.mjs)
import {
  BUNDLED_MENUS, TEXT_MENU_PROMPT, countItems, extractLinks, extractPdfText,
  fetchMenuForPlace, htmlToText, isGarbledPdfText,
  menuLinkCandidates, normalizePdfText, parseMenuHeuristic, pickPdfFallback,
  splitPrice, validateMenu,
} from './src/menus.js'
import { readFileSync } from 'node:fs'

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

// Bundled menus: valid, correctly sized, provenance intact
const solare = BUNDLED_MENUS['seed:solare']
const starlite = BUNDLED_MENUS['seed:starlite']
const tadokoro = BUNDLED_MENUS['seed:tadokoro']
check('solare validates clean', validateMenu(solare).length === 0)
check('solare has 85 items', countItems(solare) === 85)
check('solare carries provenance (source url + fetch date)',
  solare.source_url?.includes('solarelounge.com') && Boolean(solare.fetched_at))
check('starlite validates clean', validateMenu(starlite).length === 0)
check('starlite has 49 items', countItems(starlite) === 49)
check('tadokoro is the honest no-menu record',
  tadokoro.is_menu === false && countItems(tadokoro) === 0
  && validateMenu(tadokoro).length === 0)

// Validator catches real breakage
check('validator flags a string price',
  validateMenu({ sections: [{ name: 'Mains', items: [{ name: 'X', price: '$12' }] }] }).length > 0)
check('validator flags a missing section name',
  validateMenu({ sections: [{ items: [] }] }).length > 0)
check('validator flags a bad variant price',
  validateMenu({ sections: [{ name: 'S', items: [{ name: 'X', price: null, variants: [{ label: 'Large', price: '9' }] }] }] }).length > 0)
check('validator accepts variants done right',
  validateMenu({ sections: [{ name: 'S', items: [{ name: 'X', price: 10, variants: [{ label: 'Large', price: 14 }] }] }] }).length === 0)
check('validator rejects a non-object', validateMenu([1, 2]).length > 0)

// Prompt fidelity with M0
check('prompt keeps the {menu_text} slot', TEXT_MENU_PROMPT.includes('{menu_text}'))
check('prompt keeps the not-a-menu escape', TEXT_MENU_PROMPT.includes('"is_menu": false'))
check('prompt forbids inventing dishes', TEXT_MENU_PROMPT.includes('Never invent dishes'))

// Link discovery: ranking + the plan's delivery-platform exclusion
const fixtureHtml = `
  <a href="/about">About us</a>
  <a href="/menus/dinner">Dinner Menu</a>
  <a href="https://www.doordash.com/store/123">Order on DoorDash</a>
  <a href="/docs/menu.pdf">Full menu (PDF)</a>
  <a href="https://example-other.com/menu">Menu elsewhere</a>
  <a href="/contact">Contact</a>`
const links = extractLinks(fixtureHtml, 'https://restaurant.example/')
const candidates = menuLinkCandidates(links, 'https://restaurant.example/')
check('link extraction found the anchors', links.length === 6)
check('delivery-platform link is excluded',
  !candidates.some((c) => c.href.includes('doordash')))
check('off-site non-PDF link is excluded',
  !candidates.some((c) => c.href.includes('example-other.com')))
check('PDF menu ranks first (score 7 = pdf 3 + hint 2 + label 2)',
  candidates[0]?.href.endsWith('menu.pdf') && candidates[0]?.score === 7)
check('same-site menu page is a candidate',
  candidates.some((c) => c.href.endsWith('/menus/dinner')))

// Text reduction
const messy = '<html><head><style>x{}</style><script>var a=1</script></head>' +
  '<body><h1>Starters</h1><p>Calamari 14</p><p>   </p><p>Soup 9</p></body></html>'
const cleaned = htmlToText(messy)
check('htmlToText strips scripts/styles/tags',
  cleaned.includes('Calamari 14') && !cleaned.includes('var a=1') && !cleaned.includes('<'))
check('htmlToText drops blank lines', !cleaned.split('\n').some((l) => l.trim() === ''))

// --- Heuristic puller (v1.2.0: website menu pulling without an AI key) ---
check('splitPrice reads a $-decimal price', splitPrice('Grilled Salmon $24.50')?.price === 24.5)
check('splitPrice reads a dotted-leader bare price', splitPrice('Tomato Soup .... 9')?.price === 9)
check('splitPrice ignores a year', splitPrice('Established 2024') === null)
check('splitPrice ignores a street number', splitPrice('2820 Roosevelt Rd') === null)

const menuText = [
  'STARTERS',
  'Crispy Calamari $14',
  'lemon aioli, marinara',
  'Tomato Basil Soup',
  '9',
  'MAINS',
  'Grilled Salmon $28.50',
  'charred lemon, herbs',
  'Ribeye Steak — market price',
  'dry aged in house',
  'Margherita Pizza',
  'san marzano tomato, mozzarella, basil',
  'Tiramisu $11',
  'espresso-soaked ladyfingers',
].join('\n')
const pulled = parseMenuHeuristic(menuText)
check('heuristic recognises a real menu', pulled.is_menu === true)
check('heuristic output passes the schema validator', validateMenu(pulled).length === 0)
check('heuristic finds both caps sections',
  pulled.sections.map((s) => s.name).join('|') === 'STARTERS|MAINS')
const pulledItems = pulled.sections.flatMap((s) => s.items)
check('heuristic pulls 6 dishes', pulledItems.length === 6)
check('trailing-price dish parsed with description',
  pulledItems.find((i) => i.name === 'Crispy Calamari')?.price === 14
  && pulledItems.find((i) => i.name === 'Crispy Calamari')?.description?.includes('aioli'))
check('price-on-next-line dish parsed',
  pulledItems.find((i) => i.name === 'Tomato Basil Soup')?.price === 9)
check('market price dish kept with null price',
  pulledItems.find((i) => i.name === 'Ribeye Steak')?.price === null)
check('priceless dish after a priced anchor keeps its description',
  pulledItems.find((i) => i.name === 'Margherita Pizza')?.description?.includes('mozzarella'))

// PDF fallback discipline (real-data lesson, 2026-10-31): only menu-like
// PDFs may be presented as a place's menu.
check('pdf fallback accepts a menu-named PDF',
  pickPdfFallback([{ href: 'https://x.example/docs/Dine-In-Menu.pdf', label: 'Menu' }])
    === 'https://x.example/docs/Dine-In-Menu.pdf')
check('pdf fallback rejects a jukebox song list',
  pickPdfFallback([{ href: 'https://hodads.example/allsongs.pdf', label: 'Song list' }]) === null)
check('pdf fallback rejects an unrelated industry PDF',
  pickPdfFallback([{ href: 'https://assoc.example/Marketing_and_Advertising_Code.pdf', label: 'Code' }]) === null)

// Layouts measured on Lucha Libre's real menu page (2026-10-31): decorated
// price lines ("- 16 |") and a caps dish name with its price on the next line.
const luchaText = [
  'CALI BURRITOS',
  'CLASSIC CALI',
  'Chicken',
  '- 16   |',
  'Pork Adobada',
  '- 16   |',
  'Steak',
  '- 18',
  'Fresh Fries, Sour Cream, Pico de Gallo & Jack Cheese',
  'POBLANO CALI',
  '- 17',
].join('\n')
const lucha = parseMenuHeuristic(luchaText)
const luchaItems = lucha.sections.flatMap((s) => s.items)
check('decorated price lines parse (Lucha layout)', lucha.is_menu === true && luchaItems.length === 4)
check('variant-style dishes keep their prices',
  luchaItems.find((i) => i.name === 'Chicken')?.price === 16
  && luchaItems.find((i) => i.name === 'Steak')?.price === 18)
check('caps dish with next-line price is a dish, not a section',
  luchaItems.find((i) => i.name === 'POBLANO CALI')?.price === 17
  && !lucha.sections.some((s) => s.name === 'POBLANO CALI'))

const homeText = [
  'Welcome to Bella Notte',
  'A neighborhood Italian kitchen in the heart of the city',
  '2820 Roosevelt Rd, San Diego',
  'Monday - Friday 11am - 10pm',
  'Call us at 619-555-0142',
  'Book a table for your next celebration',
  'Gift cards available in store',
  'Follow us for daily specials and events',
].join('\n')
const notMenu = parseMenuHeuristic(homeText)
check('heuristic refuses homepage text (no invented menu)',
  notMenu.is_menu === false && notMenu.sections.length === 0)

// --- PDF menus (v1.3.0) -------------------------------------------------
// Normalization: spaceless caps dish names get their spaces back,
// section headers stay caps, glyph soup is dropped, icon junk stripped.
const tgNorm = normalizePdfText([
  'FRIEDCHICKENSANDWICH@',
  'country-style fried chicken breast, cabbage slaw,',
  'SOUPS',
  'GREENPOZOLE@@@',
  'shredded chicken, hominy, tomatillos, onions,',
  '.......-___...... .............. ~:J{ua/__..,_......',
].join('\n'))
check('pdf normalize re-spaces merged dish names', tgNorm.includes('Fried Chicken Sandwich'))
check('pdf normalize keeps section headers caps', tgNorm.split('\n').includes('SOUPS'))
check('pdf normalize strips icon junk', !tgNorm.includes('@'))
check('pdf normalize drops glyph-soup lines', !tgNorm.includes('___'))

// Priceless parsing: a no-price menu parses only with the PDF opt-in.
const tgText = [
  'SANDWICHES', 'Fried Chicken Sandwich', 'country-style fried chicken breast, cabbage slaw, pickles',
  'Grilled Steak', 'sliced steak, horseradish aioli, arugula, grilled sourdough bread',
  'Chicken Pesto Sandwich', 'chicken breast, provolone, preserved tomatoes, arugula, pesto',
  'Tomato Mozzarella Sandwich', 'mozzarella, preserved tomatoes, arugula, sunflower seed pesto',
  'SOUPS', 'Green Pozole', 'shredded chicken, hominy, tomatillos, onions, cabbage, radish',
  'Rustic Chicken', 'potato, carrot, celery, onion, thyme, rich chicken broth',
  'Roasted Tomato', 'sourdough croutons and basil oil, shaved parmesan cheese',
].join('\n')
const tgParsed = parseMenuHeuristic(tgText, { pricelessOk: true })
check('priceless PDF text parses as a menu with the opt-in',
  tgParsed.is_menu && tgParsed.sections.flatMap((s) => s.items).length >= 6
  && tgParsed.sections.flatMap((s) => s.items).every((it) => it.price === null))
check('same text refused without the opt-in (anchor rule intact)',
  parseMenuHeuristic(tgText).is_menu === false)

// Garble gate (Point Loma class: substitution-cipher extraction).
check('garble gate flags cipher text',
  isGarbledPdfText('normal start  more text  with controls everywhere ' + 'x'.repeat(300) + ''.repeat(20)))
check('garble gate passes real menu text',
  !isGarbledPdfText('Margherita 18\nDiavola 21\n'.repeat(30)))

// Extraction from a real (synthetic-fixture) PDF + end-to-end flow:
// homepage links a PDF -> fetchMenuForPlace parses it into a menu.
const fixtureBytes = readFileSync(new URL('./test-fixtures/menu.pdf', import.meta.url))
const pdfText = await extractPdfText(fixtureBytes)
check('pdf extraction reads the fixture menu', pdfText.includes('Margherita 18') && pdfText.includes('ANTIPASTI'))
{
  const realFetch = globalThis.fetch
  const home = '<html><body><a href="/menu.pdf">Our menu</a></body></html>'
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('menu.pdf')) {
      return { ok: true, text: async () => '%PDF-1.4 (binary served as text)', arrayBuffer: async () => fixtureBytes.buffer.slice(fixtureBytes.byteOffset, fixtureBytes.byteOffset + fixtureBytes.byteLength) }
    }
    return { ok: true, text: async () => home, arrayBuffer: async () => new ArrayBuffer(0) }
  }
  const res = await fetchMenuForPlace(
    { name: 'Fixture Pizza', website: 'https://fixture.example/' },
    { apiKey: '', baseUrl: '', model: '' })
  check('flow: linked PDF becomes a parsed menu',
    res.kind === 'menu' && res.menu.from_pdf === true && countItems(res.menu) >= 4)
  globalThis.fetch = realFetch
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures ? 1 : 0)

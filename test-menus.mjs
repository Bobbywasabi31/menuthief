// Logic checks for the M2 menu layer (run: node test-menus.mjs)
import {
  BUNDLED_MENUS, TEXT_MENU_PROMPT, countItems, extractLinks, htmlToText,
  menuLinkCandidates, validateMenu,
} from './src/menus.js'

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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures ? 1 : 0)

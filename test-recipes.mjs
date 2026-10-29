// Logic checks for the M3 recipe layer (run: node test-recipes.mjs)
import {
  BUNDLED_RECIPES, RECIPE_PROMPT, formatQty, loadBundledRecipe, recipeKey,
  scaleQty, validateRecipe,
} from './src/recipes.js'

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

// Bundled recipes: valid + reachable through the registry key path
const aragosta = loadBundledRecipe('seed:solare', "Fettuccine all'Aragosta")
const burger = loadBundledRecipe('seed:starlite', 'Starlite Burger')
check('aragosta recipe found via registry', aragosta !== null)
check('aragosta validates clean', aragosta && validateRecipe(aragosta).length === 0)
check('aragosta anchored on the menu description',
  aragosta.ingredients.some((i) => i.item.includes('mascarpone'))
  && aragosta.ingredients.some((i) => i.item.includes('lobster')))
check('burger recipe found via registry', burger !== null)
check('burger validates clean', burger && validateRecipe(burger).length === 0)
check('burger anchored on the menu description',
  burger.ingredients.some((i) => i.item.toLowerCase().includes('gruyère'))
  && burger.steps.some((s) => s.toLowerCase().includes('dijonnaise')))
check('unknown dish has no bundled recipe',
  loadBundledRecipe('seed:solare', 'Panna Cotta') === null)
check('registry size matches BUNDLED_RECIPES', Object.keys(BUNDLED_RECIPES).length === 2)
check('recipeKey normalizes case and space',
  recipeKey('seed:x', '  Starlite Burger ') === 'seed:x::starlite burger')

// Validator catches breakage
check('validator flags empty ingredients',
  validateRecipe({ servings: 2, ingredients: [], steps: ['x'] }).length > 0)
check('validator flags a string qty',
  validateRecipe({ servings: 2, ingredients: [{ qty: '1', item: 'egg' }], steps: ['x'] }).length > 0)
check('validator flags non-string steps',
  validateRecipe({ servings: 2, ingredients: [{ qty: 1, item: 'egg' }], steps: [42] }).length > 0)
check('validator flags a bad difficulty',
  validateRecipe({ servings: 2, difficulty: 'brutal', ingredients: [{ item: 'egg' }], steps: ['x'] }).length > 0)
check('validator accepts a minimal recipe',
  validateRecipe({ servings: 2, ingredients: [{ qty: null, item: 'salt' }], steps: ['Season.'] }).length === 0)

// Prompt: framing + slots
check('prompt frames it as a home version, not the restaurant recipe',
  RECIPE_PROMPT.includes('HOME VERSION inspired by')
  && RECIPE_PROMPT.includes('never claim or imply it is'))
check('prompt carries all four slots',
  ['{dish_name}', '{dish_description}', '{place_name}', '{cuisine}']
    .every((s) => RECIPE_PROMPT.includes(s)))

// Quantity math
check('formatQty: 0.5 -> ½', formatQty(0.5) === '½')
check('formatQty: 1.5 -> 1 ½', formatQty(1.5) === '1 ½')
check('formatQty: 0.33 -> ⅓', formatQty(0.33) === '⅓')
check('formatQty: 0.75 -> ¾', formatQty(0.75) === '¾')
check('formatQty: 2 -> 2', formatQty(2) === '2')
check('formatQty: null -> empty', formatQty(null) === '')
check('scaleQty doubles', scaleQty(0.75, 2) === 1.5)
check('scaleQty keeps null null', scaleQty(null, 3) === null)
check('scaled aragosta wine reads 1 at 2x',
  formatQty(scaleQty(0.5, 2)) === '1')

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures ? 1 : 0)

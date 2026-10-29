// MenuThief M3 — home recipes for menu dishes. A recipe here is always a
// home-cook version INSPIRED BY the restaurant's dish, never the
// restaurant's own recipe (plan rule) — the prompt says so and the UI
// labels it. Generation uses the same bring-your-own-key endpoint as M2;
// recipes cache on-device per place + dish.

export const RECIPE_PROMPT = `You write home-cook recipes inspired by restaurant menu dishes.

Input: a dish name, its menu description, and the restaurant's name and cuisine.

Rules:
- Output ONLY a JSON object matching this shape, no commentary, no code fences:
{
  "servings": 2,
  "prep_minutes": 15,
  "cook_minutes": 25,
  "difficulty": "easy" | "medium" | "advanced",
  "ingredients": [
    {"qty": 0.5, "unit": "cup", "item": "dry white wine", "note": null}
  ],
  "steps": ["Step one, written as a plain instruction."],
  "tips": ["One genuinely useful tip."]
}
- This is a HOME VERSION inspired by the dish — never claim or imply it is
  the restaurant's actual recipe.
- Anchor the recipe on the ingredients and flavors named in the menu
  description. Where the description is thin, use the classic preparation
  of the named dish. Never invent a different dish.
- Supermarket ingredients only; no restaurant-only equipment. Quantities
  are numbers (fractions as decimals, e.g. 0.5); qty is null for
  to-taste items like salt. "unit" is null when it doesn't apply.
- Steps are ordered and concise, with temperatures and times where they
  matter. 5-10 steps. At most 3 tips.

Dish: {dish_name}
Menu description: {dish_description}
Restaurant: {place_name} ({cuisine})`

// ---------------------------------------------------------------------------
// Validator (same style as the M0/M2 menu validator).
// ---------------------------------------------------------------------------

const DIFFICULTIES = ['easy', 'medium', 'advanced']

export function validateRecipe(obj) {
  const errors = []
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return ['top level is not an object']
  }
  if (typeof obj.servings !== 'number' || obj.servings <= 0) {
    errors.push('servings missing or not a positive number')
  }
  for (const key of ['prep_minutes', 'cook_minutes']) {
    const v = obj[key]
    if (v !== null && v !== undefined && typeof v !== 'number') {
      errors.push(`${key} not numeric/null`)
    }
  }
  if (obj.difficulty !== undefined && !DIFFICULTIES.includes(obj.difficulty)) {
    errors.push('difficulty not easy|medium|advanced')
  }
  if (!Array.isArray(obj.ingredients) || obj.ingredients.length === 0) {
    errors.push('ingredients missing or empty')
  } else {
    obj.ingredients.forEach((ing, i) => {
      if (typeof ing?.item !== 'string' || !ing.item.trim()) {
        errors.push(`ingredient ${i}: item missing`)
      }
      const q = ing?.qty
      if (q !== null && q !== undefined && typeof q !== 'number') {
        errors.push(`ingredient ${i}: qty not numeric/null`)
      }
      for (const key of ['unit', 'note']) {
        const v = ing?.[key]
        if (v !== null && v !== undefined && typeof v !== 'string') {
          errors.push(`ingredient ${i}: ${key} not string/null`)
        }
      }
    })
  }
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    errors.push('steps missing or empty')
  } else if (!obj.steps.every((s) => typeof s === 'string' && s.trim())) {
    errors.push('every step must be a non-empty string')
  }
  if (obj.tips !== undefined
    && (!Array.isArray(obj.tips) || !obj.tips.every((t) => typeof t === 'string'))) {
    errors.push('tips must be a list of strings')
  }
  return errors
}

// ---------------------------------------------------------------------------
// Quantity formatting + scaling — 0.5 at scale 2 reads "1", 0.75 reads "¾".
// ---------------------------------------------------------------------------

const FRACTIONS = [
  [0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [2 / 3, '⅔'], [0.75, '¾'],
]

export function formatQty(value) {
  if (value === null || value === undefined) return ''
  const rounded = Math.round(value * 12) / 12
  const whole = Math.floor(rounded)
  const frac = rounded - whole
  for (const [v, glyph] of FRACTIONS) {
    if (Math.abs(frac - v) < 0.04) return whole ? `${whole} ${glyph}` : glyph
  }
  if (frac < 0.04) return `${whole}`
  const trimmed = (Math.round(rounded * 100) / 100).toString()
  return trimmed
}

export function scaleQty(qty, scale) {
  if (qty === null || qty === undefined) return null
  return qty * scale
}

// ---------------------------------------------------------------------------
// Cache (localStorage, per place + dish).
// ---------------------------------------------------------------------------

const CACHE_KEY = 'menumap-recipe-cache-v1'

function storage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

export function recipeKey(placeId, dishName) {
  return `${placeId}::${dishName.toLowerCase().trim()}`
}

export function loadCachedRecipe(placeId, dishName) {
  const raw = storage()?.getItem(CACHE_KEY)
  if (!raw) return null
  try { return JSON.parse(raw)[recipeKey(placeId, dishName)] || null } catch { return null }
}

export function saveCachedRecipe(placeId, dishName, recipe) {
  const store = storage()
  if (!store) return
  let all = {}
  try { all = JSON.parse(store.getItem(CACHE_KEY) || '{}') } catch { /* fresh */ }
  all[recipeKey(placeId, dishName)] = recipe
  try { store.setItem(CACHE_KEY, JSON.stringify(all)) } catch { /* quota: skip */ }
}

// ---------------------------------------------------------------------------
// Generation via the BYOK endpoint (settings come from menus.js).
// ---------------------------------------------------------------------------

export async function generateRecipe({ dish, place }, settings) {
  if (!settings.apiKey) throw new Error('NO_KEY')
  const content = RECIPE_PROMPT
    .replace('{dish_name}', dish.name)
    .replace('{dish_description}', dish.description || '(no description on the menu)')
    .replace('{place_name}', place.name)
    .replace('{cuisine}', place.cuisine || 'unspecified')
  const base = settings.baseUrl.replace(/\/$/, '')
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.4,
      messages: [{ role: 'user', content }],
    }),
  })
  if (!resp.ok) throw new Error(`AI endpoint returned HTTP ${resp.status}`)
  const json = await resp.json()
  const raw = json.choices?.[0]?.message?.content || ''
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error('The AI response was not valid JSON')
  }
  const errors = validateRecipe(parsed)
  if (errors.length) throw new Error('AI recipe failed validation: ' + errors[0])
  return {
    ...parsed,
    dish_name: dish.name,
    place_name: place.name,
    generated_at: new Date().toISOString(),
    engine: `api:${settings.model}`,
  }
}

// ---------------------------------------------------------------------------
// Bundled sample recipes — written for the demo dishes so the tap-a-dish
// flow works with no key. Labeled in the UI as bundled samples.
// ---------------------------------------------------------------------------

import aragostaRecipe from './data/recipe-aragosta.js'
import starliteBurgerRecipe from './data/recipe-starlite-burger.js'

export const BUNDLED_RECIPES = {
  'seed:solare::fettuccine all\'aragosta': aragostaRecipe,
  'seed:starlite::starlite burger': starliteBurgerRecipe,
}

export function loadBundledRecipe(placeId, dishName) {
  return BUNDLED_RECIPES[recipeKey(placeId, dishName)] || null
}

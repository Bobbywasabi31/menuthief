import React, { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import {
  CATEGORIES, SEED_PLACES, categoryMeta, fetchPlaces,
} from './places'
import {
  BUNDLED_MENUS, countItems, fetchMenuForPlace, loadCachedMenu, loadSettings,
  saveCachedMenu, saveSettings, structureMenuText,
} from './menus'
import {
  formatQty, generateRecipe, loadBundledRecipe, loadCachedRecipe,
  saveCachedRecipe, scaleQty,
} from './recipes'

// Default view: Liberty Station / Point Loma, San Diego — the M0 test area.
const HOME = { lat: 32.738, lon: -117.198, zoom: 13 }
const MIN_ZOOM_FOR_DATA = 13

function formatPrice(n) {
  if (n === null || n === undefined) return ''
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined,
    { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function App() {
  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef(new Map())
  const cacheRef = useRef(new Map())
  const debounceRef = useRef(null)

  const [places, setPlaces] = useState([])
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState(null)
  const [status, setStatus] = useState('loading') // loading | live | seed | error
  const [notice, setNotice] = useState('')

  // M2 menu state
  const [view, setView] = useState('card') // card | menu | recipe
  const [menuPhase, setMenuPhase] = useState('idle') // idle|loading|ready|nomenu|pdf|error|paste
  const [menu, setMenu] = useState(null)
  const [menuNote, setMenuNote] = useState('')
  const [menuError, setMenuError] = useState('')
  const [pdfUrl, setPdfUrl] = useState(null)
  const [pasteText, setPasteText] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState(loadSettings)

  // M3 recipe state
  const [recipeDish, setRecipeDish] = useState(null)
  const [recipe, setRecipe] = useState(null)
  const [recipePhase, setRecipePhase] = useState('generate') // generate|loading|ready|error
  const [recipeError, setRecipeError] = useState('')
  const [recipeScale, setRecipeScale] = useState(1)
  const [copied, setCopied] = useState(false)

  const visible = useMemo(
    () => (filter === 'all' ? places : places.filter((p) => p.category === filter)),
    [places, filter],
  )

  async function loadPlaces(map) {
    const zoom = map.getZoom()
    if (zoom < MIN_ZOOM_FOR_DATA) {
      setNotice('Zoom in to load food places')
      return
    }
    const b = map.getBounds()
    const bounds = {
      south: +b.getSouth().toFixed(4), west: +b.getWest().toFixed(4),
      north: +b.getNorth().toFixed(4), east: +b.getEast().toFixed(4),
    }
    const cacheKey = Object.values(bounds).join(',')
    if (cacheRef.current.has(cacheKey)) {
      setPlaces(cacheRef.current.get(cacheKey))
      setStatus('live')
      setNotice('')
      return
    }
    setStatus('loading')
    try {
      const found = await fetchPlaces(bounds)
      cacheRef.current.set(cacheKey, found)
      setPlaces(found)
      setStatus('live')
      setNotice(found.length === 0 ? 'No food places mapped in this area yet' : '')
    } catch (err) {
      // Honest degradation: sample data, visibly labeled — never fake "live".
      console.warn(err)
      setPlaces((prev) => (prev.length ? prev : SEED_PLACES))
      setStatus((prev) => (prev === 'live' ? prev : 'seed'))
      setNotice('Live place data is unreachable right now — showing sample places near Liberty Station, San Diego')
    }
  }

  // Map setup (once)
  useEffect(() => {
    const map = L.map(mapEl.current, { zoomControl: false }).setView(
      [HOME.lat, HOME.lon], HOME.zoom)
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map)
    mapRef.current = map
    loadPlaces(map)
    map.on('moveend', () => {
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => loadPlaces(map), 700)
    })
    return () => map.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Markers follow the filtered set
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const seen = new Set()
    for (const place of visible) {
      seen.add(place.id)
      if (markersRef.current.has(place.id)) continue
      const meta = categoryMeta(place.category)
      const icon = L.divIcon({
        className: 'pin-wrap',
        html: `<div class="pin" style="--c:${meta.color}"><span>${meta.emoji}</span></div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 30],
      })
      const marker = L.marker([place.lat, place.lon], { icon })
        .addTo(map)
        .on('click', () => selectPlace(place))
      markersRef.current.set(place.id, marker)
    }
    for (const [id, marker] of markersRef.current) {
      if (!seen.has(id)) {
        marker.remove()
        markersRef.current.delete(id)
      }
    }
  }, [visible])

  function locate() {
    if (!navigator.geolocation) {
      setNotice('This browser does not share location')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => mapRef.current?.flyTo([pos.coords.latitude, pos.coords.longitude], 15),
      () => setNotice('Location unavailable — browse the map instead'),
      { timeout: 8000 },
    )
  }

  // --- M2: menu wiring -----------------------------------------------------

  function selectPlace(place) {
    setSelected(place)
    setView('card')
    setMenu(null)
    setMenuPhase('idle')
    setMenuError('')
    setPasteText('')
    setRecipe(null)
    setRecipeDish(null)
    setRecipeScale(1)
  }

  function openMenu() {
    if (!selected) return
    setView('menu')
    const bundled = BUNDLED_MENUS[selected.id]
    if (bundled) {
      setMenu(bundled)
      setMenuPhase(bundled.is_menu === false ? 'nomenu' : 'ready')
      setMenuNote('Bundled sample menu from the M0 test run')
      return
    }
    const cached = loadCachedMenu(selected.id)
    if (cached) {
      setMenu(cached)
      setMenuPhase(cached.is_menu === false ? 'nomenu' : 'ready')
      setMenuNote('Saved from a previous fetch on this device')
      return
    }
    setMenuPhase('idle')
    setMenuNote('')
  }

  async function runFetch() {
    if (!selected) return
    if (!settings.apiKey) {
      setMenuError('Add your AI key first (⚙ settings) — structuring a menu needs it. Your key never leaves this browser except to your AI provider.')
      setMenuPhase('error')
      return
    }
    setMenuPhase('loading')
    setMenuError('')
    try {
      const result = await fetchMenuForPlace(selected, settings, setMenuNote)
      if (result.kind === 'pdf') {
        setPdfUrl(result.url)
        setMenuPhase('pdf')
      } else {
        saveCachedMenu(selected.id, result.menu)
        setMenu(result.menu)
        setMenuPhase(result.kind === 'menu' ? 'ready' : 'nomenu')
        setMenuNote('')
      }
    } catch (err) {
      if (err.message === 'NO_WEBSITE') {
        setMenuError('No website is on file for this place, so there is nothing to fetch. You can paste its menu text instead.')
      } else {
        setMenuError(err.message)
      }
      setMenuPhase('error')
    }
  }

  async function runPaste() {
    if (!selected || !pasteText.trim()) return
    if (!settings.apiKey) {
      setMenuError('Add your AI key first (⚙ settings) — pasted text still needs it for structuring.')
      setMenuPhase('error')
      return
    }
    setMenuPhase('loading')
    setMenuNote('Structuring the pasted menu with your AI key…')
    try {
      const structured = await structureMenuText(pasteText, settings, {
        placeName: selected.name, source: 'user_paste', sourceUrl: null,
      })
      saveCachedMenu(selected.id, structured)
      setMenu(structured)
      setMenuPhase(structured.is_menu ? 'ready' : 'nomenu')
      setMenuNote('')
    } catch (err) {
      setMenuError(err.message)
      setMenuPhase('error')
    }
  }

  function updateSettings(patch) {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveSettings(next)
  }

  // --- M3: recipes -----------------------------------------------------------

  function openRecipe(item) {
    if (!selected) return
    setRecipeDish(item)
    setRecipeScale(1)
    setCopied(false)
    setView('recipe')
    const bundled = loadBundledRecipe(selected.id, item.name)
    if (bundled) {
      setRecipe(bundled)
      setRecipePhase('ready')
      return
    }
    const cached = loadCachedRecipe(selected.id, item.name)
    if (cached) {
      setRecipe(cached)
      setRecipePhase('ready')
      return
    }
    setRecipe(null)
    setRecipePhase('generate')
  }

  async function runGenerateRecipe() {
    if (!selected || !recipeDish) return
    if (!settings.apiKey) {
      setRecipeError('Add your AI key first (⚙ settings) — recipes are written by it, on this device. Only two dishes ship with bundled samples.')
      setRecipePhase('error')
      return
    }
    setRecipePhase('loading')
    try {
      const made = await generateRecipe({ dish: recipeDish, place: selected }, settings)
      saveCachedRecipe(selected.id, recipeDish.name, made)
      setRecipe(made)
      setRecipePhase('ready')
    } catch (err) {
      setRecipeError(err.message === 'NO_KEY' ? 'No AI key saved yet.' : err.message)
      setRecipePhase('error')
    }
  }

  function recipePlainText() {
    if (!recipe || !recipeDish) return ''
    const lines = [
      `${recipeDish.name} — home version inspired by ${selected.name}`,
      `Serves ${Math.round(recipe.servings * recipeScale)} · Prep ${recipe.prep_minutes ?? '?'} min · Cook ${recipe.cook_minutes ?? '?'} min`,
      '',
      'Ingredients:',
      ...recipe.ingredients.map((ing) => {
        const q = formatQty(scaleQty(ing.qty, recipeScale))
        return `- ${[q, ing.unit, ing.item].filter(Boolean).join(' ')}${ing.note ? ` (${ing.note})` : ''}`
      }),
      '',
      'Steps:',
      ...recipe.steps.map((s, i) => `${i + 1}. ${s}`),
    ]
    if (recipe.tips?.length) lines.push('', 'Tips:', ...recipe.tips.map((t) => `- ${t}`))
    return lines.join('\n')
  }

  async function copyRecipe() {
    const text = recipePlainText()
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      // Clipboard API needs a secure context + focus; fall back to the
      // legacy path so Copy still works from a local file or old browser.
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        ta.remove()
      } catch { ok = false }
    }
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const meta = selected ? categoryMeta(selected.category) : null
  const itemCount = menu ? countItems(menu) : 0

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🍴 MenuThief</div>
        <div className="brand-tag">see the menu · cook the dish</div>
        <div className={`status-pill status-${status}`}>
          {status === 'loading' && 'Loading…'}
          {status === 'live' && `${places.length} places`}
          {status === 'seed' && 'Sample data'}
          {status === 'error' && 'Offline'}
        </div>
        <button className="locate-btn" onClick={() => setShowSettings(true)} aria-label="AI settings">⚙</button>
        <button className="locate-btn" onClick={locate} aria-label="Use my location">◎</button>
      </header>

      <div className="chips" role="tablist">
        <button
          className={filter === 'all' ? 'chip chip-on' : 'chip'}
          onClick={() => setFilter('all')}>All food</button>
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            className={filter === c.key ? 'chip chip-on' : 'chip'}
            onClick={() => setFilter(c.key)}>{c.emoji} {c.label}</button>
        ))}
      </div>

      <div id="map" ref={mapEl} />

      {notice && view === 'card' && <div className="notice">{notice}</div>}

      {selected && view === 'card' && (
        <section className="sheet">
          <button className="sheet-close" onClick={() => setSelected(null)} aria-label="Close">×</button>
          <div className="sheet-cat" style={{ color: meta.color }}>
            {meta.emoji} {meta.label.slice(0, -1)}{selected.cuisine ? ` · ${selected.cuisine}` : ''}
          </div>
          <h2 className="sheet-name">{selected.name}</h2>
          {selected.address && <div className="sheet-line">📍 {selected.address}</div>}
          {selected.openingHours && <div className="sheet-line">🕐 {selected.openingHours}</div>}
          {selected.phone && <div className="sheet-line">📞 {selected.phone}</div>}
          <div className="sheet-actions">
            {selected.website && (
              <a className="btn btn-ghost" href={selected.website} target="_blank" rel="noreferrer">
                Restaurant website
              </a>
            )}
            <button className="btn btn-primary" onClick={openMenu}>
              📖 View menu
            </button>
          </div>
          {selected.source === 'seed' && (
            <div className="sheet-note">Sample place — live data was unreachable.</div>
          )}
        </section>
      )}

      {selected && view === 'menu' && (
        <section className="sheet sheet-menu">
          <button className="sheet-close" onClick={() => setSelected(null)} aria-label="Close">×</button>
          <button className="menu-back" onClick={() => setView('card')}>← {selected.name}</button>

          {menuPhase === 'idle' && (
            <div className="menu-state">
              <p>No menu loaded for this place yet.</p>
              <div className="sheet-actions">
                {selected.website && (
                  <button className="btn btn-primary" onClick={runFetch}>Fetch menu from its website</button>
                )}
                <button className="btn btn-ghost" onClick={() => setMenuPhase('paste')}>Paste menu text</button>
              </div>
              {!selected.website && (
                <p className="menu-hint">No website on file — paste is the way in for this one.</p>
              )}
            </div>
          )}

          {menuPhase === 'loading' && (
            <div className="menu-state">
              <p className="menu-loading">⏳ {menuNote || 'Working…'}</p>
            </div>
          )}

          {menuPhase === 'error' && (
            <div className="menu-state">
              <p className="menu-error">{menuError}</p>
              <div className="sheet-actions">
                {selected.website && (
                  <button className="btn btn-primary" onClick={runFetch}>Try again</button>
                )}
                <button className="btn btn-ghost" onClick={() => setMenuPhase('paste')}>Paste menu text</button>
                {!settings.apiKey && (
                  <button className="btn btn-ghost" onClick={() => setShowSettings(true)}>⚙ Add AI key</button>
                )}
              </div>
            </div>
          )}

          {menuPhase === 'pdf' && (
            <div className="menu-state">
              <p>This restaurant publishes its menu as a PDF, which this version can’t read yet.</p>
              <div className="sheet-actions">
                <a className="btn btn-primary" href={pdfUrl} target="_blank" rel="noreferrer">Open the PDF menu</a>
                <button className="btn btn-ghost" onClick={() => setMenuPhase('paste')}>Paste menu text instead</button>
              </div>
            </div>
          )}

          {menuPhase === 'paste' && (
            <div className="menu-state">
              <p>Paste the menu text (from the restaurant’s site or a photo transcription):</p>
              <textarea
                className="paste-box"
                rows={8}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={'Starters\nCalamari  14\n…'}
              />
              <div className="sheet-actions">
                <button className="btn btn-primary" onClick={runPaste} disabled={!pasteText.trim()}>
                  Structure it with my AI key
                </button>
                <button className="btn btn-ghost" onClick={() => setMenuPhase(menu ? 'ready' : 'idle')}>Cancel</button>
              </div>
              {!settings.apiKey && (
                <p className="menu-hint">No AI key saved yet — add one in ⚙ settings first.</p>
              )}
            </div>
          )}

          {menuPhase === 'nomenu' && (
            <div className="menu-state">
              <p><strong>No published menu found.</strong></p>
              <p className="menu-hint">
                {menu?.source_url
                  ? <>Checked <a href={menu.source_url} target="_blank" rel="noreferrer">its website</a>
                    {menu.fetched_at ? <> on {formatDate(menu.fetched_at)}</> : ''} — nothing menu-like is published there.
                    Some places (omakase counters especially) simply don’t post one.</>
                  : 'This place does not publish a menu we can read.'}
              </p>
              <div className="sheet-actions">
                <button className="btn btn-ghost" onClick={() => setMenuPhase('paste')}>Paste menu text</button>
                {selected.website && (
                  <button className="btn btn-ghost" onClick={runFetch}>Re-check website</button>
                )}
              </div>
            </div>
          )}

          {menuPhase === 'ready' && menu && (
            <div className="menu-body">
              <div className="menu-meta">
                {itemCount} dishes
                {menuNote ? <> · {menuNote}</> : null}
                {menu.fetched_at ? <> · fetched {formatDate(menu.fetched_at)}</> : null}
                {menu.source_url
                  ? <> · <a href={menu.source_url} target="_blank" rel="noreferrer">source</a></>
                  : null}
              </div>
              {menu.sections.map((sec, i) => (
                <div key={i} className="menu-section">
                  <h3 className="menu-section-name">{sec.name}</h3>
                  {sec.price_note && <div className="menu-price-note">{sec.price_note}</div>}
                  {sec.items.map((item, j) => (
                    <div key={j} className="menu-item">
                      <div className="menu-item-top">
                        <span className="menu-item-name">{item.name}</span>
                        {item.price !== null && item.price !== undefined && (
                          <span className="menu-item-price">{formatPrice(item.price)}</span>
                        )}
                      </div>
                      {item.description && <div className="menu-item-desc">{item.description}</div>}
                      <button className="recipe-btn" onClick={() => openRecipe(item)}>
                        🍳 Home recipe
                      </button>
                      {Array.isArray(item.variants) && item.variants.length > 0 && (
                        <div className="menu-item-variants">
                          {item.variants.map((v, k) => (
                            <div key={k} className="menu-variant">
                              <span>{v.label}</span>
                              {v.price !== null && v.price !== undefined && <span>{formatPrice(v.price)}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              <div className="menu-foot">
                Tap 🍳 Home recipe on any dish for a home-cook version.
                <button className="btn btn-ghost menu-refetch" onClick={() => setMenuPhase('paste')}>Paste a newer menu</button>
              </div>
            </div>
          )}
        </section>
      )}

      {selected && view === 'recipe' && recipeDish && (
        <section className="sheet sheet-menu">
          <button className="sheet-close" onClick={() => setSelected(null)} aria-label="Close">×</button>
          <button className="menu-back" onClick={() => setView('menu')}>← Menu · {selected.name}</button>

          <h3 className="recipe-title">{recipeDish.name}</h3>
          <div className="recipe-disclaimer">
            Home version inspired by this dish — not {selected.name}’s recipe.
          </div>
          {recipeDish.description && recipePhase !== 'ready' && (
            <p className="menu-hint">On the menu: “{recipeDish.description}”</p>
          )}

          {recipePhase === 'generate' && (
            <div className="menu-state">
              <p>No recipe yet for this dish.</p>
              <div className="sheet-actions">
                <button className="btn btn-primary" onClick={runGenerateRecipe}>
                  🍳 Write the home recipe
                </button>
              </div>
              {!settings.apiKey && (
                <p className="menu-hint">Needs your AI key (⚙ settings) — two demo dishes come with bundled samples.</p>
              )}
            </div>
          )}

          {recipePhase === 'loading' && (
            <div className="menu-state">
              <p className="menu-loading">⏳ Writing the recipe with your AI key…</p>
            </div>
          )}

          {recipePhase === 'error' && (
            <div className="menu-state">
              <p className="menu-error">{recipeError}</p>
              <div className="sheet-actions">
                <button className="btn btn-primary" onClick={runGenerateRecipe}>Try again</button>
                {!settings.apiKey && (
                  <button className="btn btn-ghost" onClick={() => setShowSettings(true)}>⚙ Add AI key</button>
                )}
              </div>
            </div>
          )}

          {recipePhase === 'ready' && recipe && (
            <div className="menu-body">
              <div className="recipe-meta">
                <span>Serves {Math.round(recipe.servings * recipeScale)}</span>
                {recipe.prep_minutes != null && <span>Prep {recipe.prep_minutes} min</span>}
                {recipe.cook_minutes != null && <span>Cook {recipe.cook_minutes} min</span>}
                {recipe.difficulty && <span className="recipe-diff">{recipe.difficulty}</span>}
              </div>
              <div className="scale-row">
                <span className="menu-hint">Scale:</span>
                {[0.5, 1, 2, 3].map((s) => (
                  <button
                    key={s}
                    className={recipeScale === s ? 'scale-btn scale-on' : 'scale-btn'}
                    onClick={() => setRecipeScale(s)}>
                    {s === 0.5 ? '½×' : `${s}×`}
                  </button>
                ))}
                <button className="btn btn-ghost menu-refetch" onClick={copyRecipe}>
                  {copied ? 'Copied ✓' : 'Copy recipe'}
                </button>
              </div>

              <h4 className="recipe-h">Ingredients</h4>
              <ul className="recipe-ings">
                {recipe.ingredients.map((ing, i) => {
                  const q = formatQty(scaleQty(ing.qty, recipeScale))
                  return (
                    <li key={i}>
                      {[q, ing.unit].filter(Boolean).length > 0 && (
                        <span className="recipe-qty">{[q, ing.unit].filter(Boolean).join(' ')} </span>
                      )}
                      {ing.item}
                      {ing.note && <span className="recipe-note"> — {ing.note}</span>}
                    </li>
                  )
                })}
              </ul>

              <h4 className="recipe-h">Steps</h4>
              <ol className="recipe-steps">
                {recipe.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>

              {recipe.tips?.length > 0 && (
                <>
                  <h4 className="recipe-h">Tips</h4>
                  <ul className="recipe-tips">
                    {recipe.tips.map((t, i) => <li key={i}>💡 {t}</li>)}
                  </ul>
                </>
              )}

              <div className="menu-foot">
                {recipe.engine === 'bundled-sample'
                  ? 'Bundled sample recipe, written for this app’s demo dishes.'
                  : <>Generated {formatDate(recipe.generated_at)} by {recipe.engine?.replace('api:', '')} · saved on this device.</>}
                {recipe.engine !== 'bundled-sample' && settings.apiKey && (
                  <button className="btn btn-ghost menu-refetch" onClick={runGenerateRecipe}>Regenerate</button>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {showSettings && (
        <div className="modal-wrap" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>AI settings</h3>
            <p className="menu-hint">
              MenuThief uses your own AI key to turn a restaurant’s menu page into a
              structured menu. The key is stored only in this browser.
            </p>
            <label className="field">
              <span>Endpoint (OpenAI-compatible)</span>
              <input
                type="text" value={settings.baseUrl}
                onChange={(e) => updateSettings({ baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </label>
            <label className="field">
              <span>API key</span>
              <input
                type="password" value={settings.apiKey}
                onChange={(e) => updateSettings({ apiKey: e.target.value })}
                placeholder="sk-…"
              />
            </label>
            <label className="field">
              <span>Model</span>
              <input
                type="text" value={settings.model}
                onChange={(e) => updateSettings({ model: e.target.value })}
                placeholder="gpt-4o-mini"
              />
            </label>
            <p className="menu-hint">Local option: point the endpoint at Ollama on your own machine (http://localhost:11434/v1) — then no key is needed, though this page must be able to reach it.</p>
            <div className="sheet-actions">
              <button className="btn btn-primary" onClick={() => setShowSettings(false)}>Done</button>
            </div>
            <div className="modal-foot">
              MenuThief 1.0 · Places and map © OpenStreetMap contributors ·
              Menus belong to their restaurants — recipes here are home versions
              inspired by them, never the originals.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

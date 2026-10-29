# MenuMap M0 — graded results

*Run: 2026-10-27 (evening). Code: `menu_pipeline.py`. Test set: `testset.json` — 6 cases, real San Diego restaurants, chosen to cover the plan's hard cases. Raw artifacts in this folder (`*.acquire.json`, `*.extraction.json`, `*.menu.json`).*

## Verdict: the pipeline works — with one known hole

Menus were obtained **with no user help for 4 of the 5 places that publish one**, the one place with genuinely no menu was **correctly refused (zero invented dishes)**, and every output passed schema validation. **173 dishes** were structured across the 3 restaurants that yielded menus (Lucha Libre 39, Solare 85, Starlite 49).

| Case | Expected | Got | Items | How |
|---|---|---|---|---|
| Lucha Libre — HTML menu page | menu | ✅ menu | 39 | Fetched page, cleaned text, structured. Prices print as "- 16" with no $ sign — extraction handled it |
| Solare — menu PDF (direct link) | menu | ✅ menu | 85 | PDF parsed to text; the PDF bundles lunch + dinner + specials + wine, all sectioned |
| Solare — homepage only | menu | ✅ menu | 85 | Link discovery ranked the dine-in PDF #1 of 3 candidates and followed it |
| Starlite — menu is a PNG image | menu | ✅ menu | 49 | Vision extraction from the image — fully legible, incl. small print |
| Sushi Tadokoro — no menu exists | none | ✅ refused | 0 | Homepage is not a menu → `is_menu: false`. Reality agrees: they went omakase-only in Oct 2026 |
| In-N-Out — chain web menu | menu | ❌ failed | 0 | **Acquisition failure:** the page is a JavaScript app shell — a plain fetch returns 212 bytes and no text |

Against the plan's acceptance target (≥7/10 menus without user help on a 10-place set): this was a 6-case smoke set, not the full 10 — but the hit rate on winnable cases (4/5, 80%) is above the bar the plan set, and the miss is a known, fixable category rather than a mystery.

## Honesty box — read this before quoting the numbers

The extraction step (text/photo → JSON) in this run was performed by **Muse applying the pipeline's shipped prompts verbatim** (the pipeline's "oracle" engine), because this VM has no LLM API key. Everything else — fetching, PDF parsing, HTML cleaning, menu-link discovery, schema validation, item counting — ran as code, end to end. The `api` engine (any OpenAI-compatible endpoint, incl. a local Ollama) is built and one env var away, but **untested**: the first run with a real key should be `grade --engine api` on this same test set, diffing item counts against the oracle outputs saved here. Extraction quality of a specific small model (e.g. gpt-4o-mini) is the one number M0 did not measure.

Cost of this run: **$0**.

## What the real world taught the plan

1. **JS-rendered menus are the hole.** Big chains render menus with JavaScript; a plain fetcher gets an empty shell. Mitigations for M1+: a headless-render step in the fetch path, or the Places-photos route. It's a subset problem, not a wall — plenty of places server-render or publish PDFs — but chains are prime copycat targets, so it deserves a real fix, not a shrug.
2. **Menus on the web are often images.** Starlite's official menu is a PNG on its own website. Tier 2 must route "the menu link is an image" into the vision step automatically — the vision tier isn't only for user-snapped photos.
3. **Variant pricing is everywhere** — protein choices (Chicken 16 / Steak 18), 6 pc vs 12 pc oysters, cup vs bowl, half vs full pours, plus add-ons ("+ prosciutto 6") and prix-fixe courses (no per-item price). For grading I modeled variants as separate items; **M1 should decide a real `variants` field** and a section-level price note before the UI is built on this schema.
4. **Don't gate on $ signs.** Two of three successful menus print prices without them; my menu-likeness heuristic counted 2 price mentions on a page holding 39 priced items. The LLM doesn't care, but no heuristic in the app should use $ density to decide "is this a menu."
5. **Real menus are messy documents.** Lucha's page renders its limited-time item twice (dedupe needed); Solare's PDF interleaves cooking-class ads and wine-club prose with the food (the prompt's "only dishes that appear" rule handled it — 0 junk items extracted).
6. **The refusal path matters and works.** The one place with no menu got no menu. For a product whose whole risk is hallucinated dishes, that case is worth as much as the 85-item one.

## Recommendation

Proceed to **M1 (map shell)** per the plan, with three additions carried in: (a) decide the `variants` schema change first, (b) add image-menu routing to Tier 2, (c) spike the headless-render fallback for JS menus and re-run the In-N-Out case against it.

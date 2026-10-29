# MenuMap M0 — menu pipeline test

Proves the core of the MenuMap MVP plan (`~/workspace/your_files/menu-to-recipe-mvp-plan.md` §11, step M0): given a real restaurant, obtain its menu as structured JSON matching the plan's data model — or refuse honestly when no menu exists.

**Graded results: see `RESULTS.md`.** Test set: `testset.json`. Raw run artifacts: `results/`.

## Run it

```bash
python3 -m venv .venv && .venv/bin/pip install requests pypdf beautifulsoup4

# See what menu links a restaurant homepage offers (PDFs, menu pages):
.venv/bin/python menu_pipeline.py discover https://solarelounge.com/

# Fetch a menu page/PDF and reduce it to cleaned text:
.venv/bin/python menu_pipeline.py acquire <MENU_URL> --out work/case1
.venv/bin/python menu_pipeline.py extract work/case1 --engine oracle   # writes a prompt bundle
.venv/bin/python menu_pipeline.py ingest  work/case1 EXTRACTION.json    # validates + adds provenance

# Menu photo (or a menu published as an image):
.venv/bin/python menu_pipeline.py photo menu.png --place "Starlite" --out work/case2

# Full test set:
.venv/bin/python menu_pipeline.py grade testset.json --out-dir results --engine oracle
```

## Extraction engines

The extract step is a pure function (menu text/photo → JSON); the engine is pluggable and every output records which engine produced it.

- **api** — any OpenAI-compatible chat-completions endpoint. Set:
  - `MENUMAP_LLM_BASE_URL` (default `https://api.openai.com/v1`; use `http://localhost:11434/v1` for local Ollama)
  - `MENUMAP_LLM_API_KEY`
  - `MENUMAP_LLM_MODEL` (default `gpt-4o-mini`; must be vision-capable for photo inputs)
- **oracle** — no API call: the tool writes a `*.oracle.json` bundle containing the exact prompt + input; a human or another AI applies it and `ingest` validates the result. This is how the 2026-10-27 grading run was produced (no LLM key exists in that environment) — see the honesty box in `RESULTS.md`.

## Rules baked in (from the plan)

- Delivery platforms (DoorDash/Uber Eats/…) are never a data source, including as followed links.
- A place with no findable menu yields `is_menu: false` — the pipeline must never invent dishes.
- Every Menu JSON carries provenance: source type, source URL, fetch time, engine.

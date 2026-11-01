# MenuThief real-data pull — 2026-10-31

Not simulated. On 2026-10-31 the app's own shipped code (`src/menus.js`:
link discovery, candidate ranking, text reduction, and the v1.2.0
heuristic parser, on the no-AI-key path) was run against **15 real San
Diego restaurant websites**, fetched live. Full structured results —
including the complete pulled menus — are in
`menuthief-pulled-menus-2026-10-31.json` next to this report.

Method notes (honesty): fetching used curl through this machine's
internet proxy because Node's fetch can't use it; every discovery and
parsing decision was made by the app's code, unmodified during the run.
Text extraction used the parser's Node fallback path; the browser's
innerText segmentation may differ slightly on-device.

## Results: 5 menus, 168 dishes — plus 3 real menu PDFs found

| Place | Result | Detail |
|---|---|---|
| Buona Forchetta | ✅ menu | **104 dishes** from `/dinner-menu/` |
| Lucha Libre Taco Shop | ✅ menu | **35 dishes** from `/menu/` (matches the AI pipeline's graded layout findings) |
| Mitch's Seafood | ✅ menu | 11 dishes from its homepage |
| Stone Brewing (Liberty Station) | ✅ menu | 10 dishes from `/menus` |
| Hodad's | ✅ menu | 8 dishes from its homepage |
| Solare Ristorante | 📄 PDF | its real dine-in menu PDF |
| Point Loma Seafoods | 📄 PDF | its real menu PDF (dated 2026-04-16) |
| Tender Greens | 📄 PDF | its real Fall 2026 menu PDF |
| Sushi Tadokoro | 🚫 no menu | **correct** — omakase, publishes none (known ground truth) |
| In-N-Out Burger | 🚫 no menu | JS-rendered menu page; static fetch can't read it (known case) |
| Cucina Urbana | 🚫 no menu | menu is JS-embedded — 105 KB page, zero prices in the HTML |
| The Fishery | 🚫 no menu | `/menu` is 404; menu not found on probed paths |
| Jayne's Gastropub | 🚫 no menu | `/menu` is 404; menu not found on probed paths |
| Starlite | ⚠️ fetch failed | site returned HTTP 521 (down) at pull time |
| Corvette Diner | ⚠️ fetch failed | site unreachable at pull time |

Pulled menus are schema-valid (validator-clean) and carry provenance
(source URL + fetch timestamp + engine `heuristic`).

## What the real data caught (and the fix that shipped in v1.2.1)

The first run ranked **any** PDF above HTML menu pages (a bonus from
the original M0 ranking, where a PDF usually *is* the menu). Real sites
broke that assumption twice in 15 tries:

- Stone Brewing's homepage links a Brewers Association
  *marketing-code* PDF — the puller served it as "the menu".
- Hodad's links a *jukebox song list* PDF (`allsongs.pdf`) — same story.

Fix (v1.2.1): HTML menu pages are tried first; a PDF is only kept as a
fallback, and only if it looks like a menu (name/label matches
/menu/i). With the fix, Stone pulls its real menu and Hodad's pulls 8
dishes from its homepage; Solare / Point Loma / Tender Greens still
resolve to their genuine menu PDFs. Stubbed-flow checks pin all three
behaviors.

## Scoreboard vs. expectations

- HTML menu pulling works on real sites today — including a 104-dish
  pull — with no AI key.
- The remaining misses cluster into known classes: PDF-only menus
  (3, correctly found and linked), JS-rendered menus (2), dead-ends in
  discovery (2), and sites down/unreachable (2).
- Next levers, in order: parse the PDFs the puller already finds;
  a headless-render step for JS menus (parked by Alex 2026-10-28);
  more probe paths for the 404 class.

#!/usr/bin/env python3
"""
MenuMap M0 — menu pipeline de-risking tool.

Proves (or disproves) the core of the MenuMap MVP plan: given a real
restaurant, can we obtain its menu as structured JSON?

    acquire  -> fetch a menu page / PDF / photo, reduce it to clean text
    extract  -> an LLM turns that text (or the photo) into Menu JSON
    validate -> the Menu JSON is checked against the plan's data model

Extraction engines (the extract step is a pure function, engine is pluggable):
    api     OpenAI-compatible chat completions. Configure with env vars:
              MENUMAP_LLM_BASE_URL  (default https://api.openai.com/v1)
              MENUMAP_LLM_API_KEY   (required for the api engine)
              MENUMAP_LLM_MODEL     (default gpt-4o-mini; must be vision-capable
                                     for photo inputs, e.g. gpt-4o-mini, or a
                                     local Ollama model via base URL
                                     http://localhost:11434/v1)
    oracle  No API call. The tool writes a bundle (prompt + input) that a
            human / another AI applies the prompt to, then `ingest` validates
            the result and attaches provenance. Used for the M0 grading run in
            an environment with no LLM key; every result records its engine.

Usage:
    menu_pipeline.py acquire  URL [--out PREFIX]
    menu_pipeline.py discover HOMEPAGE_URL
    menu_pipeline.py extract  PREFIX [--engine api|oracle]
    menu_pipeline.py ingest   PREFIX EXTRACTION_JSON
    menu_pipeline.py photo    PHOTO_FILE [--place NAME] [--out PREFIX]
    menu_pipeline.py validate MENU_JSON
    menu_pipeline.py grade    MANIFEST_JSON --out-dir DIR [--engine ...]

A PREFIX is a path stem; the pipeline keeps PREFIX.acquire.json (acquisition
record + cleaned text) next to PREFIX.menu.json (final Menu JSON).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0 Safari/537.36 MenuMapM0/0.1"
)
FETCH_TIMEOUT_S = 30
MAX_TEXT_CHARS = 60_000  # cap what we hand the extraction model

PRICE_RE = re.compile(r"\$\s?\d{1,3}(?:\.\d{2})?\b")
MENU_LINK_HINTS = ("menu", "menus", "food-menu", "dinner", "lunch", "brunch")

# ---------------------------------------------------------------------------
# Prompts — these exact strings are what the api engine sends, and what the
# oracle engine bundle contains. Changing a prompt changes the experiment.
# ---------------------------------------------------------------------------

MENU_SCHEMA_SNIPPET = """{
  "is_menu": true,
  "sections": [
    {"name": "Section name (e.g. Starters, Mains, Desserts)",
     "items": [
       {"name": "Dish name exactly as written",
        "description": "Description exactly as written, or null if none",
        "price": 16.50}
     ]}
  ]
}"""

TEXT_MENU_PROMPT = """You convert restaurant menu text into structured JSON.

Rules:
- Output ONLY a JSON object matching this shape, no commentary, no code fences:
""" + MENU_SCHEMA_SNIPPET + """
- Include ONLY dishes that actually appear in the text. Never invent dishes,
  descriptions, or prices.
- "price" is a number in dollars (16.50) or null when no price is shown.
- Keep dish names and descriptions verbatim (fix only obvious line-wrap splits).
- Group items under the section headings used by the menu itself; if the menu
  has no sections, use one section named "Menu".
- If the text is NOT a restaurant menu (e.g. a homepage, an article, a
  reservation page), output {"is_menu": false, "sections": []}.
- Menus sometimes list several menus (lunch/dinner/drinks) in one document;
  include all of them, using their headings as sections.

Menu text follows:
---
{menu_text}
---"""

PHOTO_MENU_PROMPT = """You read a photo of a restaurant menu and convert it into structured JSON.

Rules:
- Output ONLY a JSON object matching this shape, no commentary, no code fences:
""" + MENU_SCHEMA_SNIPPET + """
- Transcribe ONLY what is legible in the photo. Never invent dishes,
  descriptions, or prices. If part of the menu is cut off or unreadable,
  include only the items you can actually read.
- "price" is a number in dollars (16.50) or null when no price is shown.
- Group items under the section headings visible in the photo; if none, use
  one section named "Menu".
- If the image is NOT a restaurant menu, output {"is_menu": false, "sections": []}.
"""

# ---------------------------------------------------------------------------
# Acquisition
# ---------------------------------------------------------------------------


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_bytes(url: str) -> tuple[str, bytes]:
    resp = requests.get(
        url, headers={"User-Agent": USER_AGENT}, timeout=FETCH_TIMEOUT_S
    )
    resp.raise_for_status()
    return resp.headers.get("Content-Type", ""), resp.content


def pdf_to_text(data: bytes) -> str:
    from io import BytesIO

    from pypdf import PdfReader

    reader = PdfReader(BytesIO(data))
    pages = [(page.extract_text() or "") for page in reader.pages]
    return "\n".join(pages)


def html_to_text_and_links(html: bytes, base_url: str) -> tuple[str, list[dict]]:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "iframe"]):
        tag.decompose()
    links: list[dict] = []
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"])
        label = a.get_text(" ", strip=True)
        links.append({"href": href, "label": label})
    text = soup.get_text("\n")
    lines = [ln.strip() for ln in text.splitlines()]
    text = "\n".join(ln for ln in lines if ln)
    return text, links


def menu_link_candidates(links: list[dict], base_url: str) -> list[dict]:
    """Rank links that plausibly lead to a menu (page or PDF)."""
    base_host = urlparse(base_url).netloc
    scored: list[tuple[int, dict]] = []
    for link in links:
        href, label = link["href"], (link["label"] or "").lower()
        low = href.lower()
        if urlparse(href).netloc != base_host and not low.endswith(".pdf"):
            continue  # stay on the restaurant's own site (delivery sites excluded)
        score = 0
        if low.endswith(".pdf"):
            score += 3
        if any(h in low for h in MENU_LINK_HINTS):
            score += 2
        if "menu" in label:
            score += 2
        if any(bad in low for bad in ("doordash", "ubereats", "grubhub", "seamless")):
            continue  # plan rule: delivery platforms are not a data source
        if score >= 2:
            scored.append((score, {"href": href, "label": link["label"], "score": score}))
    scored.sort(key=lambda t: -t[0])
    seen, out = set(), []
    for _, item in scored:
        if item["href"] not in seen:
            seen.add(item["href"])
            out.append(item)
    return out


def menu_likeness(text: str) -> dict:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    prices = PRICE_RE.findall(text)
    return {
        "chars": len(text),
        "lines": len(lines),
        "price_mentions": len(prices),
        "price_density_per_100_lines": round(100 * len(prices) / max(len(lines), 1), 1),
    }


def acquire_url(url: str) -> dict:
    """Fetch a URL and reduce it to cleaned text (+ candidate menu links)."""
    record: dict = {"url": url, "fetched_at": now_iso()}
    content_type, data = fetch_bytes(url)
    record["content_type"] = content_type
    record["bytes"] = len(data)
    if "pdf" in content_type or url.lower().endswith(".pdf"):
        record["kind"] = "pdf"
        record["text"] = pdf_to_text(data)
    elif "html" in content_type or "text" in content_type:
        record["kind"] = "html"
        text, links = html_to_text_and_links(data, url)
        record["text"] = text
        record["menu_links"] = menu_link_candidates(links, url)
    else:
        record["kind"] = "other"
        record["text"] = ""
    record["stats"] = menu_likeness(record["text"])
    return record


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def llm_config() -> dict:
    return {
        "base_url": os.environ.get("MENUMAP_LLM_BASE_URL", "https://api.openai.com/v1"),
        "api_key": os.environ.get("MENUMAP_LLM_API_KEY", ""),
        "model": os.environ.get("MENUMAP_LLM_MODEL", "gpt-4o-mini"),
    }


def call_llm_api(messages: list[dict]) -> str:
    cfg = llm_config()
    if not cfg["api_key"] and "localhost" not in cfg["base_url"]:
        raise RuntimeError("MENUMAP_LLM_API_KEY is not set")
    resp = requests.post(
        f"{cfg['base_url'].rstrip('/')}/chat/completions",
        headers={
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type": "application/json",
        },
        json={"model": cfg["model"], "messages": messages, "temperature": 0},
        timeout=180,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def parse_model_json(raw: str) -> dict:
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.MULTILINE).strip()
    return json.loads(raw)


def build_text_messages(acquire_rec: dict) -> list[dict]:
    text = acquire_rec["text"][:MAX_TEXT_CHARS]
    return [{"role": "user", "content": TEXT_MENU_PROMPT.replace("{menu_text}", text)}]


def build_photo_messages(photo_path: Path) -> list[dict]:
    suffix = photo_path.suffix.lower().lstrip(".")
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
            "webp": "image/webp", "gif": "image/gif"}.get(suffix, "image/jpeg")
    b64 = base64.b64encode(photo_path.read_bytes()).decode()
    return [{
        "role": "user",
        "content": [
            {"type": "text", "text": PHOTO_MENU_PROMPT},
            {"type": "image_url",
             "image_url": {"url": f"data:{mime};base64,{b64}"}},
        ],
    }]


def validate_menu(obj: dict) -> list[str]:
    """Check a candidate extraction against the plan's Menu item model."""
    errors: list[str] = []
    if not isinstance(obj, dict):
        return ["top level is not an object"]
    if obj.get("is_menu") is False:
        return errors  # a honest 'not a menu' is a valid extraction
    sections = obj.get("sections")
    if not isinstance(sections, list):
        return ["sections missing or not a list"]
    for i, sec in enumerate(sections):
        if not isinstance(sec.get("name"), str) or not sec["name"].strip():
            errors.append(f"section {i}: name missing")
        items = sec.get("items")
        if not isinstance(items, list):
            errors.append(f"section {i}: items missing")
            continue
        for j, item in enumerate(items):
            if not isinstance(item.get("name"), str) or not item["name"].strip():
                errors.append(f"section {i} item {j}: name missing")
            price = item.get("price")
            if price is not None and not isinstance(price, (int, float)):
                errors.append(f"section {i} item {j}: price not numeric/null")
            variants = item.get("variants")
            if variants is not None:
                if not isinstance(variants, list):
                    errors.append(f"section {i} item {j}: variants not a list")
                else:
                    for k, var in enumerate(variants):
                        if not isinstance(var.get("label"), str) or not var["label"].strip():
                            errors.append(f"section {i} item {j} variant {k}: label missing")
                        vp = var.get("price")
                        if vp is not None and not isinstance(vp, (int, float)):
                            errors.append(f"section {i} item {j} variant {k}: price not numeric/null")
            desc = item.get("description")
            if desc is not None and not isinstance(desc, str):
                errors.append(f"section {i} item {j}: description not string/null")
    return errors


def count_items(menu_obj: dict) -> int:
    if menu_obj.get("is_menu") is False:
        return 0
    return sum(len(sec.get("items", [])) for sec in menu_obj.get("sections", []))


def finalize_menu(extraction: dict, *, place_name: str, source: str,
                  source_url: str | None, engine: str) -> dict:
    """Attach provenance -> the Menu object from the plan (section 4)."""
    return {
        "place_name": place_name,
        "source": source,
        "source_url": source_url,
        "fetched_at": now_iso(),
        "engine": engine,
        "is_menu": extraction.get("is_menu", True),
        "sections": extraction.get("sections", []),
    }


def write_oracle_bundle(prefix: Path, messages: list[dict], source_desc: str) -> Path:
    """Persist prompt + input so an oracle can apply the exact same prompt."""
    bundle = prefix.with_suffix(".oracle.json")
    bundle.write_text(json.dumps(
        {"source": source_desc, "messages": messages}, indent=2), encoding="utf-8")
    return bundle


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_acquire(args) -> int:
    rec = acquire_url(args.url)
    prefix = Path(args.out) if args.out else Path("acquire")
    prefix.with_suffix(".acquire.json").write_text(
        json.dumps(rec, indent=2), encoding="utf-8")
    print(json.dumps({k: rec[k] for k in
                      ("url", "kind", "content_type", "bytes")}, indent=2))
    print("stats:", json.dumps(rec["stats"]))
    print("menu link candidates:", len(rec.get("menu_links", [])))
    for link in rec.get("menu_links", [])[:8]:
        print(f"  [{link['score']}] {link['href']}  ({link['label']!r})")
    print(f"wrote {prefix}.acquire.json")
    return 0


def cmd_discover(args) -> int:
    rec = acquire_url(args.url)
    print(f"{args.url}: kind={rec['kind']} stats={json.dumps(rec['stats'])}")
    for link in rec.get("menu_links", []):
        print(f"  [{link['score']}] {link['href']}  ({link['label']!r})")
    return 0


def load_acquire(prefix: Path) -> dict:
    return json.loads(prefix.with_suffix(".acquire.json").read_text(encoding="utf-8"))


def cmd_extract(args) -> int:
    prefix = Path(args.prefix)
    rec = load_acquire(prefix)
    messages = build_text_messages(rec)
    if args.engine == "api":
        raw = call_llm_api(messages)
        extraction = parse_model_json(raw)
        engine = f"api:{llm_config()['model']}"
    else:
        bundle = write_oracle_bundle(prefix, messages, f"text from {rec['url']}")
        print(f"oracle bundle written: {bundle}")
        print("Apply the prompt in the bundle, save the JSON, then run:")
        print(f"  menu_pipeline.py ingest {prefix} YOUR_EXTRACTION.json")
        return 2
    errors = validate_menu(extraction)
    menu = finalize_menu(extraction, place_name=args.place or "",
                         source="website", source_url=rec["url"], engine=engine)
    prefix.with_suffix(".menu.json").write_text(
        json.dumps(menu, indent=2), encoding="utf-8")
    print(f"items={count_items(extraction)} validation_errors={errors}")
    print(f"wrote {prefix}.menu.json")
    return 0 if not errors else 1


def cmd_ingest(args) -> int:
    prefix = Path(args.prefix)
    extraction = json.loads(Path(args.extraction).read_text(encoding="utf-8"))
    errors = validate_menu(extraction)
    rec_path = prefix.with_suffix(".acquire.json")
    rec = json.loads(rec_path.read_text(encoding="utf-8")) if rec_path.exists() else {}
    menu = finalize_menu(
        extraction, place_name=args.place or rec.get("place_name", ""),
        source=args.source or rec.get("kind_source", "website"),
        source_url=rec.get("url"), engine=args.engine_label)
    prefix.with_suffix(".menu.json").write_text(
        json.dumps(menu, indent=2), encoding="utf-8")
    print(f"items={count_items(extraction)} validation_errors={errors}")
    print(f"wrote {prefix}.menu.json")
    return 0 if not errors else 1


def cmd_photo(args) -> int:
    photo = Path(args.photo)
    prefix = Path(args.out) if args.out else photo.with_suffix("")
    messages = build_photo_messages(photo)
    rec = {"url": None, "kind": "photo", "kind_source": "user_photo",
           "place_name": args.place or "", "fetched_at": now_iso(),
           "photo": str(photo)}
    prefix.with_suffix(".acquire.json").write_text(
        json.dumps(rec, indent=2), encoding="utf-8")
    if args.engine == "api":
        raw = call_llm_api(messages)
        extraction = parse_model_json(raw)
        errors = validate_menu(extraction)
        menu = finalize_menu(extraction, place_name=args.place or "",
                             source="user_photo", source_url=None,
                             engine=f"api:{llm_config()['model']}")
        prefix.with_suffix(".menu.json").write_text(
            json.dumps(menu, indent=2), encoding="utf-8")
        print(f"items={count_items(extraction)} validation_errors={errors}")
        return 0 if not errors else 1
    bundle = write_oracle_bundle(prefix, messages, f"photo {photo}")
    print(f"oracle bundle written: {bundle} (image inlined as data URL)")
    return 2


def cmd_validate(args) -> int:
    obj = json.loads(Path(args.menu_json).read_text(encoding="utf-8"))
    extraction = {"is_menu": obj.get("is_menu", True), "sections": obj.get("sections")}
    errors = validate_menu(extraction)
    print(f"items={count_items(extraction)} validation_errors={errors}")
    return 0 if not errors else 1


def cmd_grade(args) -> int:
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for case in manifest["cases"]:
        prefix = out_dir / case["id"]
        row = {"id": case["id"], "name": case["name"], "kind": case["kind"],
               "expect": case.get("expect", "menu")}
        try:
            if case["kind"] in ("html", "pdf", "homepage"):
                rec = acquire_url(case["url"])
                rec["place_name"] = case["name"]
                if case["kind"] == "homepage":
                    rec["kind_source"] = "website"
                    links = rec.get("menu_links", [])
                    if links:
                        # Tier 2 behavior: follow the best menu link and use
                        # ITS content as the extraction input.
                        followed = acquire_url(links[0]["href"])
                        row["followed_url"] = links[0]["href"]
                        rec["homepage_text"] = rec["text"]
                        rec["url"] = links[0]["href"]
                        rec["kind"] = followed["kind"]
                        rec["content_type"] = followed["content_type"]
                        rec["text"] = followed["text"]
                        rec["stats"] = followed["stats"]
                prefix.with_suffix(".acquire.json").write_text(
                    json.dumps(rec, indent=2), encoding="utf-8")
                row["acquire_ok"] = True
                row["stats"] = rec["stats"]
                row["menu_links"] = [l["href"] for l in rec.get("menu_links", [])]
                if args.engine == "api":
                    extraction = parse_model_json(call_llm_api(build_text_messages(rec)))
                    menu = finalize_menu(extraction, place_name=case["name"],
                                         source="website", source_url=case["url"],
                                         engine=f"api:{llm_config()['model']}")
                    prefix.with_suffix(".menu.json").write_text(
                        json.dumps(menu, indent=2), encoding="utf-8")
                    row["items"] = count_items(extraction)
                    row["validation_errors"] = validate_menu(extraction)
                else:
                    write_oracle_bundle(prefix, build_text_messages(rec),
                                        f"text from {case['url']}")
                    row["items"] = None  # pending oracle extraction + ingest
            elif case["kind"] == "photo":
                photo = Path(case["photo"])
                messages = build_photo_messages(photo)
                write_oracle_bundle(prefix, messages, f"photo {photo}")
                (prefix.with_suffix(".acquire.json")).write_text(json.dumps(
                    {"url": None, "kind": "photo", "kind_source": "user_photo",
                     "place_name": case["name"], "photo": str(photo),
                     "fetched_at": now_iso()}, indent=2), encoding="utf-8")
                row["acquire_ok"] = True
                row["items"] = None
            else:
                row["acquire_ok"] = False
                row["error"] = f"unknown kind {case['kind']}"
        except Exception as exc:  # acquisition failure is a gradeable result
            row["acquire_ok"] = False
            row["error"] = f"{type(exc).__name__}: {exc}"
        rows.append(row)
        print(json.dumps(row))
    (out_dir / "grade_acquire.json").write_text(
        json.dumps(rows, indent=2), encoding="utf-8")
    print(f"\nwrote {out_dir}/grade_acquire.json")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="MenuMap M0 menu pipeline")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("acquire"); p.add_argument("url"); p.add_argument("--out")
    p.set_defaults(fn=cmd_acquire)

    p = sub.add_parser("discover"); p.add_argument("url")
    p.set_defaults(fn=cmd_discover)

    p = sub.add_parser("extract"); p.add_argument("prefix")
    p.add_argument("--engine", choices=["api", "oracle"], default="oracle")
    p.add_argument("--place")
    p.set_defaults(fn=cmd_extract)

    p = sub.add_parser("ingest"); p.add_argument("prefix")
    p.add_argument("extraction"); p.add_argument("--place")
    p.add_argument("--source"); p.add_argument("--engine-label", default="oracle")
    p.set_defaults(fn=cmd_ingest)

    p = sub.add_parser("photo"); p.add_argument("photo")
    p.add_argument("--place"); p.add_argument("--out")
    p.add_argument("--engine", choices=["api", "oracle"], default="oracle")
    p.set_defaults(fn=cmd_photo)

    p = sub.add_parser("validate"); p.add_argument("menu_json")
    p.set_defaults(fn=cmd_validate)

    p = sub.add_parser("grade"); p.add_argument("manifest")
    p.add_argument("--out-dir", required=True)
    p.add_argument("--engine", choices=["api", "oracle"], default="oracle")
    p.set_defaults(fn=cmd_grade)

    args = parser.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())

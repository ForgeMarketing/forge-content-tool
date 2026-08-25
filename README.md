# forge-content-tool

Forge — VSL Engine. Internal single-file tool (`index.html`, no build step) for generating direct-response video ad **concepts** for clients.

## The concept unit

One generation = 1–5 concepts. Each concept is what Forge sells:

- **1 full script** in the Forge structure: callout → pain/proof hook → full offer in the first 5–15s → social proof stack → bumper CTA
- **4 alternate hooks** (typed, drop-in replacements for the script's opening)
- **Creator brief**: wardrobe, setting, delivery, tone notes
- why-it-converts rationale + a winner pick across the batch

## Architecture

- **Prompt**: built entirely client-side in `buildPrompt()`. Exemplar scripts live in the `EXEMPLARS` const — swap in real winning scripts there to steer style.
- **LLM**: Cloudflare worker `forge-api-proxy.kyle-d56.workers.dev` (open proxy; parses Claude's JSON server-side and returns the parsed object; accepts `{prompt, max_tokens}`). CORS allows only `https://forgemarketing.github.io` — generation does not work from localhost.
- **Persistence**: Supabase PostgREST (anon key). Tables: `clients`, `client_versions`, `generations`, `client_files`.
- **Generations storage**: `generations.concepts` (jsonb) holds the full concept objects (`alt_hooks` + `brief` nested inside), `output_type: 'concepts'`, `hooks: []`, and `stage/goal/angle/length` store control **ids** (`cold`, `lead_form`, `90-120`, …). Rows with any other `output_type` are legacy and are normalized on load (`normalizeGeneration`) — old history keeps working, no schema migration was needed.

## Model output contract

```json
{ "concepts": [ { "title", "hook", "script",
    "alt_hooks": [ {"hook","type","why"} ],
    "brief": { "wardrobe", "setting", "delivery", "tone_notes" },
    "why_it_converts" } ],
  "winner_pick": "..." }
```

## Website intake (auto-fill from a URL)

The profile's "AI Auto-Fill" section accepts a client website URL. The app POSTs `{action:'fetch_site', url}` to the worker, which crawls the homepage plus up to 4 service/testimonial/about-style subpages and returns stripped page text; the pages then run through the same extraction prompt and review panel as uploaded files. The extraction prioritizes verbatim social proof (→ proof1/proof2/voice) and the service list (→ appended to the "Anything Else" field as `Services offered:`).

**Worker prerequisite:** the worker must include the fetch-site mode. The complete worker source lives at [worker/forge-api-proxy.js](worker/forge-api-proxy.js) — paste the whole file over the worker in the Cloudflare dashboard and deploy (the `ANTHROPIC_API_KEY` secret is set in worker Settings, never in the file). It also allows `http://localhost:8137` for local dev.

## Concept focus

The Generate rail has a "Concept focus" input: empty = general brand ads (ICP callout, brand as hero); a specific service/offer anchors every concept's callout, offer statement, proof selection, and bumper CTA on it. The focus is stamped on stored concepts (`_focus` in the jsonb) so history rows keep it.

## Exports

Per concept: client DOCX/PDF (script only), internal DOCX/PDF (creator brief + alternate hooks + script), **editor package DOCX/PDF** (versions to cut — one per hook variant — edit brief with pacing/captions/on-screen-text/b-roll/end-card, deliverable specs for mobile + desktop, brand notes, numbered script), hook-variant DOCX/TXT, and a ZIP-all with one indexed folder per concept.

Fulfillment flow the tool serves: onboarding call → profile intake (website scan + files) → generate concepts → creator brief + scripts go to the spokespeople → raws come back → **editor package goes to the editor with the raws** → edited files delivered to the client.

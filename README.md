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

## Exports

Per concept: client DOCX/PDF (script only), internal DOCX/PDF (creator brief + alternate hooks + script), hook-variant DOCX/TXT, and a ZIP-all with one indexed folder per concept.

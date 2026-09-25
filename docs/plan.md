# video-compare — implementation plan (rev. 2, 2026-09-24)

A/B tool for the in-house **MiniMax H3 (`renderforest-pro`)** video pipeline: replay production generations from a CSV against a **new ComfyUI workflow uploaded by the user** on gen22, and review new vs. old side by side. Third sibling of `s2s-compare` and `comfyui-eval`.

Decisions taken with Armen on 2026-09-24: scope = MiniMax replacement only · old videos come from the CSV, no baseline regeneration · uploaded workflow carries `%%VARIABLES%%` filled from the CSV · watermark off · no prompt translation · rating like comfyui-eval (prod / local / tie) · UI public on a link, no auth · no synthetic rows (cells without production data stay empty) · results exportable as CSV.

---

## 1. Facts about the production pipeline that shape the tool

Read from `origin/main`/`origin/master` of ai-video-api, ai-workers-service, ai-worker-scripts, recommendation-api, ai-image-api, ai-flow-spa, and the live `GET https://ai-video-api.renderforest.com/api/v1/models`.

### 1.1 Pipeline
```
SPA / recommendation-api (gen-ai flow) → ai-video-api → ai-workers-service → SSH tunnel → ComfyUI (vast.ai)
  POST /prompt → WS "executing node=null" → GET /history → outputs[*].gifs[0] → GET /view
  → Wasabi videos/<userId>/<projectId>.mp4 → callback → ai_video_projects.videoUrl
```
Graphs live in Postgres `ai_workflows(code, config, mapping)`; MiniMax codes: `minimax.h3.{t2v,i2v,flf,ia2v,refi2v}`. One code per **mode**, all qualities/ARs share it; dimensions are injected as data. Sources in UI format: `ai-worker-scripts/minimax-ref.json`.

### 1.2 The "styles" in the picker
The cards (Anime, Product promo, Music Video, Cinema, Cartoon, App promo, Comic book) are rows of **`video_types`**, each mapped through `video_types_has_ai_image_styles` to **`ai_image_styles`**. A style's `prompt` column becomes `styleDescription`; recommendation-api feeds it to the scene generator, which writes a style-baked `animationPrompt`, and generates a styled first-frame image. The clip is then requested from ai-video-api as **image-to-video with `prompt = animationPrompt`, `referenceMedias.images[firstFrame] = styled image`, `meta.imageStyleId = style id`, `meta.videoSource = gen-ai-flow | music-video-flow`**. Narrated scenes add `audios[voiceOver]` (+ `audioStartTime`) → `ia2v`; music-video lip-sync scenes do the same with the song.

Consequences:
- Style is **fully contained in the stored prompt + first-frame image**. The tool does not apply styles; it replays exactly what production sent. That is also why no baseline regen is needed for fairness on the prompt side.
- Style/video-type is a **grouping key**, recoverable from `ai_video_projects.meta->>'imageStyleId'` (→ `ai_image_styles.name`) and `gen_ai_projects.videoType` (join `gen_ai_projects."projectId" = (meta->>'sourceProjectId')::int`). v-editor single-clip generations have no style → group `none`.

### 1.3 renderforest-pro parameter space (live capabilities)

| Axis | Values |
|---|---|
| mode (derived from media, worker `getWorkflowConfig`) | `t2v` (no media) · `i2v` (firstFrame) · `flf` (first+last) · `ia2v` (first frame + voiceOver audio, `audioStartTime`) · `refi2v` (1–9 `referenceImage`, 0–3 `referenceAudio`; wins over the others) |
| quality | **480, 720** (1080 is not enabled for pro) |
| aspectRatio | `16:9` (default), `9:16`, `1:1`; for i2v/flf/ia2v it is inferred from the image (tolerance 0.03) |
| duration | 1–15 s (validator); production averages 90 s–19 min per clip |
| prompt | ≤ 20000 chars, not translated |
| watermark | fixed **off** for the tool |
| seed | random in prod; tool fixes one per instance |
| fps / steps / sigmas / LoRA / negative | fixed inside the graph (fps 24, MiniMax frame grid `17n+5`) |

Dimension tables the tool computes (ported verbatim from `ai-workers-service/src/core/config/config.js`):

| quality | AR | gen W×H | crop W×H | upscaleFactor |
|---|---|---|---|---|
| 480 | 16:9 / 9:16 / 1:1 | 864×480 / 480×864 / 480×480 | 854×480 / 480×854 / 480×480 | 1 |
| 720 | 16:9 / 9:16 / 1:1 | 1152×640 / 640×1152 / 640×640 | 1280×720 / 720×1280 / 720×720 | 1.34 |

Image-driven modes: `width` = shorter edge `{480: 480, 720: 640}`, crop/upscale from the row matching the image's AR. `frameCount = d*24+1`, `adjustedFrameCount = d*24`.

---

## 2. Tool design

### 2.1 Repo & runtime
- `renderforest/video-compare`, Node ≥ 22, ESM, no semicolons (s2s-compare style). Express, `better-sqlite3`, `csv-parse`, `ws`, `multer`, `dotenv`; `ffprobe` optional.
- Runs on **gen22** beside ComfyUI (`COMFY_URL=http://127.0.0.1:<port>`), UI bound to `0.0.0.0:<PORT>` and shared as `http://69.197.165.120:<PORT>` (same story as comfyui-eval). No auth, per decision.
- Layout:
  ```
  src/config.js  src/db.js  src/csv.js  src/scenario.js  src/dims.js  src/workflow.js
  src/comfy.js   src/runner.js  src/probe.js  src/server.js  src/cli/{import,plan,run,export}.js
  public/index.html (+ app.js, style.css)   workflows/*.example.json   docs/export.sql
  data/{eval.sqlite,csv/,inputs/,prod/,outputs/}   (git-ignored)
  ```

### 2.2 Input CSV (one row = one production generation)
Produced from `ai_video_projects` by `docs/export.sql` (filters: `videoSource='renderforest'`, `videoModel <> 'forest-1.0'`, `status='completed'`, `videoUrl IS NOT NULL`, date range). Header:
```
id, createdAt, userId, videoModel, quality, aspectRatio, videoDurationSeconds, prompt,
firstFrameUrl, lastFrameUrl, voiceOverUrl, audioStartTime, referenceImages, referenceAudios,
styleId, styleName, videoType, flow, width, height, videoUrl
```
`referenceImages` / `referenceAudios` are `|`-separated URLs; empty or `null` → none. `videoUrl` is the OLD video. Importer derives `mode` exactly like the worker and rejects rows that cannot be replayed (missing media, unsupported quality).

### 2.3 Coverage: how instances are grouped so every case is tested
Scenario key = `mode × quality × aspect × durationBucket × style`
- `durationBucket`: `1-3`, `4-6`, `7-10`, `11-15` s (editable in `scenarios.json`).
- `style`: `styleName` (or `videoType/styleName` when both exist), `none` for v-editor rows.
- `plan` step: build the full matrix from the catalog, intersect with the CSV, show a **coverage heatmap** (rows per cell, sampled, done, failed, rated), sample `N` rows per cell with a seeded PRNG (`--per-cell 5 --seed 42`), and list **empty cells** explicitly so the export request can be widened. No synthetic filling.
- Filters and aggregates in the UI and the export are keyed by the same cell, so "MiniMax-new wins 8/10 on `i2v · 720 · 9:16 · 4-6s · Anime`" is a first-class result.

### 2.4 Workflow upload with variables
User uploads an **API-format** ComfyUI export (dev mode → *Save (API Format)*). Production keeps five separate MiniMax graphs, one per input kind ("mode": text only, first frame, first+last frame, first frame + voice-over, reference images/audios). The tool therefore has one upload slot per mode plus a **"use for all modes"** default: if only one workflow is uploaded it is applied to every row whose media it can accept (validated by the placeholders it contains); per-mode uploads override it. The tool replaces `%%VARIABLES%%` anywhere in the JSON (same engine as comfyui-eval `instantiateWorkflow`: exact-match keeps the number type, otherwise textual replace). Vocabulary mirrors the worker's data keys:

| Placeholder | Value |
|---|---|
| `%%PROMPT%%` | CSV prompt (already style-baked) |
| `%%SEED%%` | fixed per instance |
| `%%WIDTH%%` `%%HEIGHT%%` | generation dims (table 1.3); image modes: `%%WIDTH%%` = shorter edge |
| `%%CROP_WIDTH%%` `%%CROP_HEIGHT%%` `%%UPSCALE_FACTOR%%` | output crop and MiniMax upscale multiplier |
| `%%QUALITY%%` `%%ASPECT_RATIO%%` `%%DURATION%%` `%%FPS%%` `%%FRAME_COUNT%%` `%%ADJUSTED_FRAME_COUNT%%` | as computed |
| `%%FIRST_FRAME_URL%%` `%%LAST_FRAME_URL%%` `%%AUDIO_URL%%` `%%AUDIO_START_TIME%%` | media URLs (production graphs load by URL via `LoadImageFromHttpURLNorm` / `VHS_LoadAudio`) |
| `%%FIRST_FRAME_FILE%%` … | same media uploaded to ComfyUI `input/` for graphs that use `LoadImage` |
| `%%REF_IMAGE_1..9%%` `%%REF_AUDIO_1..3%%` (+ `_FILE` variants) | reference media |
| `%%ENABLE_WATERMARK%%` | `false` |
| `%%OUTPUT_PREFIX%%` | `vc-<instanceId>` |

Unused reference slots are pruned like the worker does (`pruneUnusedReferenceInputs`: drop `ref_image_N`/`ref_audio_N` inputs beyond the provided count, and cascade-delete loader nodes left with an empty placeholder, using `/object_info` to respect required inputs). Upload validation: JSON with `class_type` nodes, must contain `%%PROMPT%%`, and per mode the required media placeholders. Workflows are stored in SQLite with a sha1; each run records which workflow ids it used.

### 2.5 Generation
1. Prefetch and cache old video + all media into `data/prod` / `data/inputs` (sha1 names); upload media to ComfyUI only when a `_FILE` placeholder is used.
2. Instantiate the graph, `POST /prompt` with a client-generated `prompt_id`, wait via WS `executing node=null` with `/history` polling fallback and `/queue` vanish detection (OOM restart → fail fast). `JOB_TIMEOUT_MS` default 30 min (MiniMax 720p 11–14 s clips average ~19 min in prod).
3. Read `outputs[*].gifs[0]` (fallback `videos`/`images`), **stream** `/view` to `data/outputs/<instanceId>.mp4`.
4. Strictly sequential (one GPU), resumable (`pending|failed|running` are retried), one automatic retry, Stop → `POST /interrupt`. Reuse cache keyed by `sha1(workflow sha1, all placeholder values, seed)`.
5. Record `duration_ms`, ComfyUI error text, and `nvidia-smi` peak memory if available.

### 2.6 Auto checks (ffprobe, optional)
Per output: width×height vs expected crop, frame count vs `duration*24`, fps, audio stream present when the mode implies audio, size/bitrate. Rendered as pass/fail badges and a filter, so reviewers skip broken outputs.

### 2.7 Review UI (comfyui-eval lineage)
- Header: run picker, workflow per mode, progress, Start/Stop, **coverage heatmap**, tallies (prod / local / tie).
- Filters: mode, quality, aspect, duration bucket, style/video type, status, rating, checks.
- Card: two `<video controls loop preload="metadata">` **Production** | **Local**, synced play/pause/scrub, prompt (copy), inputs (first/last frame thumbnails, audio player, ref thumbnails), params, duration_ms, check badges, error.
- Rating: `Prod better` / `Local better` / `Tie` (click again clears), one rating per instance, exactly as comfyui-eval. Poll every 3 s while active. Cards re-render only on status change so playback is not interrupted.

### 2.8 Export
`GET /api/runs/:id/export.csv` → every sampled instance with: all input columns, `scenarioKey`, `mode`, `seed`, `workflowSha1`, `localVideoUrl` (absolute link on the box), `status`, `durationMs`, ffprobe fields, `rating`, `ratedAt`. Plus `export-summary.csv`: per scenario cell → counts, wins, win rate, median latency.

### 2.9 SQLite schema (additive migrations)
```
runs(id, name, csv_path, created_at, sample_seed, per_cell, scenarios_json, active)
workflows(id, mode, name, json, sha1, uploaded_at)
instances(id, run_id, source_id, scenario_key, mode, quality, aspect, duration, duration_bucket,
          style_id, style_name, video_type, flow, prompt, first_frame_url, last_frame_url, audio_url,
          audio_start, ref_images_json, ref_audios_json, prod_video_url, prod_video_path, seed,
          sampled, workflow_id, comfy_prompt_id, output_path, duration_ms, probe_json, checks_json,
          status, error, attempt, rating, rated_at)
```

### 2.10 CLI
```
npm run import -- prod.csv --name sep-24          # parse, derive mode/scenario, coverage table
npm run plan   -- <runId> --per-cell 5 --seed 42  # sample per cell, list empty cells
npm run run    -- <runId>                         # sequential generation, resumable
npm run serve                                     # UI, PORT default 3001, 0.0.0.0
npm run export -- <runId> --out results.csv
```

---

## 3. Milestones

| # | Deliverable | Est. |
|---|---|---|
| 1 | Skeleton, config, DB, `docs/export.sql`, CSV import with mode/scenario derivation, coverage + sampler | 1 d |
| 2 | Placeholder engine + pruning, dims/frame math, ComfyUI client, sequential runner (resume/retry/stop/stream) | 1.5 d |
| 3 | Review UI: heatmap, filters, synced dual player, rating, live progress; workflow upload UI | 1.5 d |
| 4 | ffprobe checks, export CSVs, summary | 0.5 d |
| 5 | Deploy on gen22 (systemd unit, public port), README, `.env.example`, smoke run on one cell per mode | 0.5 d |

≈ 5 working days. Milestones 1–3 give a usable tool (≈ 4 d).

---

## 4. Closed questions (2026-09-24)

- Input CSV: Armen runs `video-compare-export.sql` (next to this file) against production; the coverage query in it is run first to pick the date window.
- Workflow granularity: unknown in advance → upload slots per mode with a "use for all modes" default (2.4).
- gen22: MiniMax video nodes/models are expected to be installed; the tool pings `/object_info` at startup and lists missing node classes referenced by an uploaded workflow.
- Sample size: chosen by the user per run in the UI/CLI; default 5 per cell.
- Public port: 3001.

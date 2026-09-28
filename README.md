# video-compare

A/B tool for the in-house **Renderforest Pro (MiniMax H3)** video generation. It replays production
generations (exported from `ai_video_projects` as a CSV) against a **new ComfyUI workflow** on a local
GPU box, and serves a review site where the old production clip and the new clip play side by side
and get rated (prod better / local better / tie). Sibling of `s2s-compare` and `comfyui-eval`.

## How it works

1. **Export** production rows with `docs/export.sql` (run the coverage query first, then the CSV export).
   One row = one completed production video with its prompt, media inputs, style and the old video URL.
2. **Import** the CSV. Every row is kept; each row is assigned a **scenario cell**
   `mode × quality × aspect × duration bucket × style`, and `N` rows per cell are sampled (seeded, stable).
   Cells with no production rows stay empty on purpose — there is nothing to compare.
3. **Upload** the candidate workflow (ComfyUI *Save (API Format)* export). The tool detects where the
   prompt, seed, duration, aspect ratio, megapixels and image/audio slots live ("bindings") and shows
   which modes the graph can replay. Bindings are editable in the UI.
4. **Generate**: sampled rows run one at a time on ComfyUI (single GPU) with a fixed seed per row,
   the output is streamed to `data/outputs/`, the old clip is archived in `data/prod/`, and ffprobe (if
   installed) records dims/fps/audio for sanity badges. Resumable, one automatic retry, Stop button.
5. **Review & export**: rows are paged and filtered server-side (default view: done + unrated), both clips
   play in sync, rate, add notes; export per-row and per-cell summary CSVs.

Comments and names: the header asks for a display name once (kept in the browser) and sends it with every rating
and comment (`x-user` header / `author` field). Each card has two comment threads, one under the production clip and one under the local clip; only the author can delete their
comment. A ★ on each card adds it to your favorites (per name); filters: "rated by", "favorited by", "★ my favorites", "with comments". Exports carry `ratedBy`, `favoritedBy` and the two comment columns.

Thumbnails: when a clip finishes (hook `generation:finished` in `src/hooks.js`) and when a production clip is
cached (`prod:cached`), a 320 px JPEG poster is written to `data/thumbs/` with ffmpeg (system binary, else the
bundled `ffmpeg-static`). Posters let the review page show every card without loading a video. Rows from before
the feature are back-filled on server start, or with the **Thumbnails** button / `POST /api/runs/:id/thumbnails`.

Mode is derived exactly like the production worker (`ai-workers-service getWorkflowConfig`):
reference media → `refi2v`, voice-over audio → `ia2v`, last frame → `flf`, first frame → `i2v`, else `t2v`.
Rows whose mode the uploaded graph cannot serve are marked **unsupported** and skipped.

## Setup

```sh
npm install
cp .env.example .env    # COMFY_URL, PORT, HOST, JOB_TIMEOUT_MS, PUBLIC_BASE_URL
npm run serve           # http://<host>:3001
```

On gen22 the ComfyUI instance is `http://127.0.0.1:8188`. Generation refuses to start and pauses itself when the data
disk has less than `MIN_FREE_DISK_GB` (default 30) free; with `COMFY_OUTPUT_DIR` set, our clips are deleted from
ComfyUI's output folder once downloaded so the disk is not used twice.

### CLI

```sh
npm run inspect -- workflows/h3_best_api.json     # what the tool detects in a workflow file
npm run import  -- prod.csv --name sep --per-cell 5 [--seed 42]
npm run run     -- <runId> [--workflow <id>]      # generate (resumable), exit 2 if anything failed
npm run export  -- <runId> [--out results.csv] [--summary summary.csv]
```

Everything is also available in the UI.

## Input CSV

Header (from `docs/export.sql`; `null`/empty allowed for nullable columns):

```
id, createdAt, userId, videoModel, quality, aspectRatio, videoDurationSeconds, prompt,
firstFrameUrl, lastFrameUrl, voiceOverUrl, audioStartTime, referenceImages, referenceAudios,
styleId, styleName, videoType, videoTypeName, flow, width, height, videoUrl, mode, durationBucket
```

`referenceImages` / `referenceAudios` are `|`-separated URLs. `videoUrl` is the production clip.
`mode` and `durationBucket` in the CSV are informational; the importer re-derives them.
Rows without `aspectRatio` (image-driven generations) get the aspect inferred from the production
output's `width`/`height` (shown with `*` in the UI).

## Workflow bindings

A raw API export needs no editing. Detected keys:

| key | filled with |
|---|---|
| `prompt` | the production prompt (already contains the style text) |
| `seed` | fixed per row (any `seed` / `noise_seed` input, Pixaroma `SeedState`) |
| `duration` | seconds (Primitive node titled "Duration…") |
| `frames` | literal frame count on a *ToVideo / *LatentVideo node (MiniMax 17n+5 grid when the node is MiniMax) |
| `aspect` | `ResolutionSelector.aspect_ratio` (combo option matched by "16:9" / "9:16" / "1:1") |
| `megapixels` | `ResolutionSelector.megapixels` from the per-quality setting (default 480p→0.1, 720p→0.2) |
| `width`, `height`, `crop_width`, `crop_height`, `upscale_factor`, `fps` | production worker tables (`src/dims.js`) |
| `image_N` / `image_url_N` | `LoadImage` (uploaded file) / URL loader nodes, in node-id order; role `firstFrame`, `lastFrame`, `reference` by title |
| `audio_url_N` | `VHS_LoadAudio` / `LoadAudio` |
| `watermark` | `ComfySwitchNode` titled "watermark" → always `false` |
| `output_prefix` | `filename_prefix` or Pixaroma `SaveVideoState.pattern` |

Unused media slots are pruned from the graph (loader node removed, dangling inputs dropped, dependents
removed when the input is required), like the production worker does for reference slots.
`%%KEY%%` placeholders (upper-case key names, e.g. `%%PROMPT%%`, `%%IMAGE_1%%`) are honoured too.

Output video is read from the prompt's history: PixaromaSaveVideo (`images[]` with `video/mp4`),
VHS_VideoCombine (`gifs[]`) or core SaveVideo (`videos[]`).

## Layout

```
src/config.js    env + paths           src/db.js        SQLite schema (data/eval.sqlite)
src/csv.js       CSV → rows, mode      src/scenario.js  import, per-cell sampling, coverage
src/dims.js      worker size tables    src/workflow.js  binding detection, graph building, pruning
src/comfy.js     ComfyUI client        src/runner.js    sequential generation loop, probe, checks
src/export.js    CSV exports           src/server.js    HTTP API + static site
src/cli/*        import / run / export / inspect        public/index.html  review UI
docs/export.sql  production export     docs/plan.md     design notes
```

State lives in `data/` (git-ignored). Deleting a run removes its videos unless another run references them.

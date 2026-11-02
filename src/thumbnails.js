import fs from 'node:fs'
import path from 'node:path'
import db from './db.js'
import config from './config.js'
import { on } from './hooks.js'
import { makeThumbnail, THUMBS_DIR } from './media.js'

const setOutputThumb = db.prepare('UPDATE instances SET output_thumb = ? WHERE id = ?')
const setProdThumb = db.prepare('UPDATE instances SET prod_thumb = ? WHERE prod_video_path = ?')

const thumbFor = async (videoPath) => makeThumbnail({ videoPath, outDir: THUMBS_DIR })

// ---- triggers ----

on('generation:finished', async ({ instance, outputPath }) => {
  const name = await thumbFor(outputPath)
  if (name) setOutputThumb.run(name, instance.id)
})

on('prod:cached', async ({ instance, filePath }) => {
  const name = await thumbFor(filePath)
  if (name) setProdThumb.run(name, instance.prod_video_path || path.basename(filePath))
})

// ---- backfill for rows that predate thumbnails (or whose ffmpeg was missing) ----

let backfillRunning = false

/** Generates missing thumbnails for a run (or every run), a few at a time. */
export const backfillThumbnails = async ({ runId = null, limit = Infinity, onProgress = () => {} } = {}) => {
  if (backfillRunning) return { skipped: 'already running' }
  backfillRunning = true
  try {
    const rows = db
      .prepare(
        `SELECT id, output_path, prod_video_path, output_thumb, prod_thumb FROM instances
         WHERE sampled = 1 ${runId ? 'AND run_id = ?' : ''}
           AND ((output_path IS NOT NULL AND output_thumb IS NULL) OR (prod_video_path IS NOT NULL AND prod_thumb IS NULL))
         ORDER BY id`
      )
      .all(...(runId ? [runId] : []))
    let made = 0
    let failed = 0
    for (const row of rows.slice(0, limit)) {
      if (row.output_path && !row.output_thumb) {
        const p = path.join(config.OUTPUTS_DIR, row.output_path)
        const name = fs.existsSync(p) ? await thumbFor(p) : null
        name ? (setOutputThumb.run(name, row.id), made++) : failed++
      }
      if (row.prod_video_path && !row.prod_thumb) {
        const p = path.join(config.PROD_DIR, row.prod_video_path)
        const name = fs.existsSync(p) ? await thumbFor(p) : null
        name ? (setProdThumb.run(name, row.prod_video_path), made++) : failed++
      }
      onProgress({ done: made, failed, total: rows.length })
    }
    return { candidates: rows.length, made, failed }
  } finally {
    backfillRunning = false
  }
}

export const isBackfillRunning = () => backfillRunning

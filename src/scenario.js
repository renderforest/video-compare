import db from './db.js'
import { parseCsvFile } from './csv.js'

// Deterministic PRNG so the same seed always draws the same sample.
const mulberry32 = (seed) => {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const shuffle = (arr, rand) => {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const insertInstance = db.prepare(`
  INSERT INTO instances (
    run_id, source_id, created_at_src, user_id, video_model, mode, quality, aspect, aspect_source,
    duration, duration_bucket, style_id, style_name, video_type, video_type_name, flow, scenario_key,
    prompt, first_frame_url, last_frame_url, audio_url, audio_start, ref_images_json, ref_audios_json,
    prod_video_url, prod_width, prod_height
  ) VALUES (
    @run_id, @source_id, @created_at_src, @user_id, @video_model, @mode, @quality, @aspect, @aspect_source,
    @duration, @duration_bucket, @style_id, @style_name, @video_type, @video_type_name, @flow, @scenario_key,
    @prompt, @first_frame_url, @last_frame_url, @audio_url, @audio_start, @ref_images_json, @ref_audios_json,
    @prod_video_url, @prod_width, @prod_height
  )
`)

/**
 * Imports every row of the CSV into a new run, then samples `perCell` rows per scenario cell.
 * @returns {{ runId: number, imported: number, skipped: object, sampled: number, cells: number }}
 */
export const importCsv = async ({ csvPath, name, perCell = 5, seed }) => {
  const sampleSeed = seed ?? Math.floor(Math.random() * 2 ** 31)
  const { rows, skipped } = await parseCsvFile(csvPath)
  if (!rows.length) throw new Error('CSV produced no importable rows (check the header matches docs/export.sql)')

  const runId = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO runs (name, csv_path, csv_rows, sample_seed, per_cell) VALUES (?, ?, ?, ?, ?)')
      .run(name, csvPath, rows.length, sampleSeed, perCell)
    for (const row of rows) insertInstance.run({ run_id: lastInsertRowid, ...row })
    return Number(lastInsertRowid)
  })()

  const sample = sampleRun({ runId, perCell, seed: sampleSeed })
  return { runId, imported: rows.length, skipped, ...sample }
}

/**
 * Brings every scenario cell to `perCell` sampled rows (seeded, stable).
 * Raising the number adds unsampled rows; lowering it drops sampled rows that have not
 * been generated yet — rows that are done, rated, or currently running are always kept,
 * so a cell can stay above the target when that much work already exists.
 */
export const sampleRun = ({ runId, perCell, seed }) => {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!run) throw new Error(`Run ${runId} not found`)
  const rand = mulberry32(seed ?? run.sample_seed)
  const rows = db
    .prepare('SELECT id, scenario_key, sampled, status, rating FROM instances WHERE run_id = ? ORDER BY id')
    .all(runId)
  const byCell = new Map()
  for (const row of rows) {
    if (!byCell.has(row.scenario_key)) byCell.set(row.scenario_key, [])
    byCell.get(row.scenario_key).push(row)
  }
  const mark = db.prepare('UPDATE instances SET sampled = 1 WHERE id = ?')
  const unmark = db.prepare("UPDATE instances SET sampled = 0, status = 'pending', error = NULL, workflow_id = NULL WHERE id = ?")
  const keep = (r) => r.status === 'done' || r.status === 'running' || r.rating
  let added = 0
  let removed = 0
  db.transaction(() => {
    for (const cellRows of byCell.values()) {
      const sampled = cellRows.filter((r) => r.sampled)
      if (sampled.length < perCell) {
        const pool = shuffle(cellRows.filter((r) => !r.sampled), rand)
        for (const row of pool.slice(0, perCell - sampled.length)) {
          mark.run(row.id)
          added += 1
        }
      } else if (sampled.length > perCell) {
        // drop from the least valuable end: unsupported/failed/pending rows, seeded order
        const droppable = shuffle(sampled.filter((r) => !keep(r)), rand)
        for (const row of droppable.slice(0, sampled.length - perCell)) {
          unmark.run(row.id)
          removed += 1
        }
      }
    }
    db.prepare('UPDATE runs SET per_cell = ? WHERE id = ?').run(perCell, runId)
  })()
  const total = db.prepare('SELECT COUNT(*) AS c FROM instances WHERE run_id = ? AND sampled = 1').get(runId).c
  return { sampled: total, added, removed, cells: byCell.size }
}

/** Coverage table: one line per scenario cell with pool/sampled/progress/rating counts. */
export const coverage = (runId) =>
  db
    .prepare(
      `SELECT scenario_key, mode, quality, aspect, duration_bucket,
              COALESCE(video_type_name, video_type) AS video_type, COALESCE(style_name, 'none') AS style,
              COUNT(*) AS pool,
              SUM(sampled) AS sampled,
              SUM(sampled AND status = 'done') AS done,
              SUM(sampled AND status = 'failed') AS failed,
              SUM(sampled AND status = 'unsupported') AS unsupported,
              SUM(sampled AND rating IS NOT NULL) AS rated,
              SUM(sampled AND rating = 'local') AS local_wins,
              SUM(sampled AND rating = 'prod') AS prod_wins,
              SUM(sampled AND rating = 'tie') AS ties
       FROM instances WHERE run_id = ?
       GROUP BY scenario_key
       ORDER BY mode, quality, aspect, duration_bucket, video_type, style`
    )
    .all(runId)

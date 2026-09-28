import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import db from './db.js'
import config from './config.js'
import { importCsv, sampleRun, coverage } from './scenario.js'
import { runPending, isRunActive, requestStop, interruptComfy, currentProgress, prepareGraph, resolveWorkflows, settingsOf, hydrate, runStopReason, startWatchdog } from './runner.js'
import { freeDiskGb, lowDiskReason } from './disk.js'
import { parseWorkflowUpload, sha1, capabilities, detectBindings, missingClasses, DETECTOR_VERSION } from './workflow.js'
import { exportInstancesCsv, exportSummaryCsv } from './export.js'
import { ComfyClient } from './comfy.js'
import { backfillThumbnails, isBackfillRunning } from './thumbnails.js'
import { THUMBS_DIR, getBinaries } from './media.js'
import { QUALITIES } from './csv.js'
import { MODES } from './workflow.js'

const app = express()
app.use(express.json({ limit: '5mb' }))
app.use(express.static(path.join(config.ROOT, 'public')))
for (const dir of [config.OUTPUTS_DIR, config.PROD_DIR, config.INPUTS_DIR, config.CSV_DIR]) fs.mkdirSync(dir, { recursive: true })
app.use('/outputs', express.static(config.OUTPUTS_DIR, { acceptRanges: true }))
app.use('/prod', express.static(config.PROD_DIR, { acceptRanges: true }))
app.use('/inputs', express.static(config.INPUTS_DIR))
app.use('/thumbs', express.static(THUMBS_DIR, { maxAge: '7d' }))

const uploadCsv = multer({ dest: config.CSV_DIR, limits: { fileSize: 1024 * 1024 * 1024 } })
const uploadJson = multer({ limits: { fileSize: 20 * 1024 * 1024 } })

const comfy = new ComfyClient({ baseUrl: config.COMFY_URL })

const runStats = db.prepare(`
  SELECT
    COUNT(*) AS pool,
    SUM(sampled) AS total,
    SUM(sampled AND status = 'done') AS done,
    SUM(sampled AND status = 'failed') AS failed,
    SUM(sampled AND status = 'running') AS running,
    SUM(sampled AND status = 'unsupported') AS unsupported,
    SUM(sampled AND rating = 'prod') AS rated_prod,
    SUM(sampled AND rating = 'local') AS rated_local,
    SUM(sampled AND rating = 'tie') AS rated_tie,
    COUNT(DISTINCT scenario_key) AS cells,
    COUNT(DISTINCT CASE WHEN sampled THEN scenario_key END) AS sampled_cells
  FROM instances WHERE run_id = ?
`)

const withStats = (run) => ({ ...run, settings: JSON.parse(run.settings_json || '{}'), ...runStats.get(run.id), active: isRunActive(run.id), stop_reason: runStopReason(run.id) || run.last_stop || null })

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
}

// ---- health ----

app.get('/api/health', handle(async (req, res) => {
  const bins = await getBinaries()
  const freeGb = await freeDiskGb().catch(() => null)
  res.json({ ok: true, comfyUrl: config.COMFY_URL, comfyReachable: await comfy.ping(), publicBaseUrl: config.PUBLIC_BASE_URL, ffmpeg: !!bins.ffmpeg, ffprobe: !!bins.ffprobe, thumbnailBackfill: isBackfillRunning(), disk: { freeGb: freeGb == null ? null : Math.round(freeGb * 10) / 10, minFreeGb: config.MIN_FREE_DISK_GB, comfyOutputDir: config.COMFY_OUTPUT_DIR || null }, defaults: { qualityMegapixels: config.DEFAULT_QUALITY_MEGAPIXELS, modes: MODES, qualities: QUALITIES } })
}))

// thumbnails are made automatically when a clip finishes; this fills in older rows
app.post('/api/runs/:id/thumbnails', (req, res) => {
  if (isBackfillRunning()) return res.status(409).json({ error: 'Thumbnail backfill already running' })
  backfillThumbnails({ runId: Number(req.params.id) }).then((r) => console.log(`[thumbs] run ${req.params.id}: ${JSON.stringify(r)}`))
  res.json({ started: true })
})

// ---- workflows ----

app.get('/api/workflows', (req, res) => {
  const rows = db.prepare('SELECT * FROM workflows ORDER BY id DESC').all().map(hydrate)
  res.json(rows.map((w) => ({ id: w.id, name: w.name, sha1: w.sha1, createdAt: w.created_at, bindings: w.bindings, capabilities: w.caps })))
})

app.get('/api/workflows/:id', handle(async (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Workflow not found' })
  const w = hydrate(row)
  const { graph, bindings } = w
  let missing = null
  try {
    missing = missingClasses({ graph, objectInfo: await comfy.getObjectInfo() })
  } catch {
    missing = null
  }
  const nodes = Object.entries(graph).map(([id, n]) => ({ id, class: n.class_type, title: n._meta?.title || '', inputs: Object.fromEntries(Object.entries(n.inputs || {}).filter(([, v]) => !Array.isArray(v))) }))
  res.json({ id: w.id, name: w.name, sha1: w.sha1, bindings, capabilities: capabilities(bindings), missingClasses: missing, nodes })
}))

app.post('/api/workflows', uploadJson.single('workflow'), handle(async (req, res) => {
  const raw = req.file ? req.file.buffer.toString('utf8') : JSON.stringify(req.body.json)
  const { graph, bindings, notes } = parseWorkflowUpload(raw)
  const name = req.body.name || (req.file ? req.file.originalname.replace(/\.json$/i, '') : `workflow-${Date.now()}`)
  const json = JSON.stringify(graph)
  const { lastInsertRowid } = db.prepare('INSERT INTO workflows (name, json, bindings_json, sha1, detector_version) VALUES (?, ?, ?, ?, ?)').run(name, json, JSON.stringify(bindings), sha1(json), DETECTOR_VERSION)
  let missing = []
  try {
    missing = missingClasses({ graph, objectInfo: await comfy.getObjectInfo({ force: true }) })
  } catch {
    notes.push('Could not reach ComfyUI to verify node classes.')
  }
  res.json({ id: Number(lastInsertRowid), name, bindings, capabilities: capabilities(bindings), notes, missingClasses: missing })
}))

app.put('/api/workflows/:id/bindings', handle(async (req, res) => {
  const w = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
  if (!w) return res.status(404).json({ error: 'Workflow not found' })
  const bindings = req.body.reset ? detectBindings(JSON.parse(w.json)).bindings : req.body.bindings
  if (!Array.isArray(bindings) || bindings.some((b) => !b.key || !b.node || !b.input)) {
    return res.status(400).json({ error: 'bindings must be an array of { key, node, input, via?, field?, role? }' })
  }
  const graph = JSON.parse(w.json)
  const unknown = bindings.filter((b) => !graph[b.node])
  if (unknown.length) return res.status(400).json({ error: `Unknown node ids: ${unknown.map((b) => b.node).join(', ')}` })
  db.prepare('UPDATE workflows SET bindings_json = ?, detector_version = ? WHERE id = ?').run(JSON.stringify(bindings), DETECTOR_VERSION, w.id)
  res.json({ ok: true, bindings, capabilities: capabilities(bindings) })
}))

app.delete('/api/workflows/:id', (req, res) => {
  db.prepare('UPDATE runs SET workflow_id = NULL WHERE workflow_id = ?').run(req.params.id)
  const result = db.prepare('DELETE FROM workflows WHERE id = ?').run(req.params.id)
  if (!result.changes) return res.status(404).json({ error: 'Workflow not found' })
  res.json({ ok: true })
})

// ---- runs ----

app.get('/api/runs', (req, res) => {
  res.json(db.prepare('SELECT * FROM runs ORDER BY id DESC').all().map(withStats))
})

app.get('/api/runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id)
  if (!run) return res.status(404).json({ error: 'Run not found' })
  res.json(withStats(run))
})

app.get('/api/runs/:id/coverage', (req, res) => {
  res.json(coverage(Number(req.params.id)))
})

// which workflow will serve each mode (explicit choice → run default → newest capable upload)
app.get('/api/runs/:id/workflows', (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id)
  if (!run) return res.status(404).json({ error: 'Run not found' })
  const { byMode, sources } = resolveWorkflows(run)
  res.json(Object.fromEntries(MODES.map((m) => [m, byMode[m] ? { id: byMode[m].id, name: byMode[m].name, source: sources[m] } : null])))
})

// Filtered + paginated page of sampled rows. Without `page` the full list is returned (CLI / scripts).
const instanceFilters = (query) => {
  const where = ['run_id = ?', 'sampled = 1']
  const params = [Number(query.runId)]
  const eq = (column, value) => {
    if (value === undefined || value === '') return
    where.push(`${column} = ?`)
    params.push(value)
  }
  eq('mode', query.mode)
  eq('quality', query.quality && Number(query.quality))
  eq('aspect', query.aspect)
  eq('duration_bucket', query.duration_bucket)
  eq('status', query.status)
  eq('scenario_key', query.scenario)
  if (query.style) {
    where.push("(COALESCE(video_type_name, video_type, '') || '|' || COALESCE(style_name, 'none')) = ?")
    params.push(query.style)
  }
  if (query.rating === 'unrated') where.push('rating IS NULL')
  else if (query.rating) {
    where.push('rating = ?')
    params.push(query.rating)
  }
  if (query.problems === '1') where.push("checks_json LIKE '%\"ok\":false%'")
  if (query.commented === '1') where.push('EXISTS (SELECT 1 FROM comments c WHERE c.instance_id = i.id)')
  if (query.rated_by) {
    where.push('rated_by = ?')
    params.push(query.rated_by)
  }
  if (query.q) {
    where.push('(prompt LIKE ? OR source_id = ?)')
    params.push(`%${query.q}%`, query.q)
  }
  return { where: where.join(' AND '), params }
}

app.get('/api/runs/:id/instances', (req, res) => {
  if (req.query.all === '1') {
    return res.json(db.prepare('SELECT * FROM instances WHERE run_id = ? ORDER BY scenario_key, id').all(req.params.id))
  }
  const { where, params } = instanceFilters({ ...req.query, runId: req.params.id })
  const withProgress = (i) => ({ ...i, progress: i.status === 'running' ? currentProgress(i.id) : null })
  if (req.query.page === undefined) {
    return res.json(db.prepare(`SELECT i.* FROM instances i WHERE ${where} ORDER BY scenario_key, id`).all(...params).map(withProgress))
  }
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 24))
  const total = db.prepare(`SELECT COUNT(*) AS c FROM instances i WHERE ${where}`).get(...params).c
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1))
  const rows = db
    .prepare(`SELECT i.*, (SELECT COUNT(*) FROM comments c WHERE c.instance_id = i.id) AS comment_count,
                     (SELECT COUNT(*) FROM comments c WHERE c.instance_id = i.id AND c.side = 'prod') AS prod_comment_count,
                     (SELECT COUNT(*) FROM comments c WHERE c.instance_id = i.id AND c.side = 'local') AS local_comment_count,
                     (SELECT GROUP_CONCAT(DISTINCT author) FROM comments c WHERE c.instance_id = i.id) AS commenters
              FROM instances i WHERE ${where} ORDER BY scenario_key, id LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize)
    .map(withProgress)
  res.json({ total, page, pages, pageSize, rows })
})

// distinct filter values, computed in SQL so the browser never loads the whole run
app.get('/api/runs/:id/filters', (req, res) => {
  const runId = Number(req.params.id)
  const distinct = (expr) => db.prepare(`SELECT DISTINCT ${expr} AS v FROM instances WHERE run_id = ? AND sampled = 1 ORDER BY 1`).all(runId).map((r) => r.v).filter((v) => v != null)
  const styles = db
    .prepare("SELECT COALESCE(video_type_name, video_type, '') AS vt, COALESCE(style_name, 'none') AS st, COUNT(*) AS c FROM instances WHERE run_id = ? AND sampled = 1 GROUP BY 1, 2 ORDER BY 1, 2")
    .all(runId)
    .map((r) => ({ value: `${r.vt}|${r.st}`, label: r.vt ? `${r.vt} / ${r.st}` : r.st, count: r.c }))
  const statuses = db.prepare('SELECT status AS v, COUNT(*) AS c FROM instances WHERE run_id = ? AND sampled = 1 GROUP BY 1 ORDER BY 1').all(runId)
  const people = db.prepare(`SELECT DISTINCT author AS v FROM comments WHERE instance_id IN (SELECT id FROM instances WHERE run_id = ?)
                             UNION SELECT DISTINCT rated_by FROM instances WHERE run_id = ? AND rated_by IS NOT NULL ORDER BY 1`).all(runId, runId).map((r) => r.v)
  res.json({ mode: distinct('mode'), quality: distinct('quality'), aspect: distinct('aspect'), duration_bucket: distinct('duration_bucket'), style: styles, status: statuses, people })
})

app.post('/api/upload', uploadCsv.single('csv'), handle(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No csv file provided' })
  const named = path.join(config.CSV_DIR, `${Date.now()}_${req.file.originalname.replace(/[^\w.-]+/g, '_')}`)
  fs.renameSync(req.file.path, named)
  const result = await importCsv({
    csvPath: named,
    name: req.body.name || req.file.originalname.replace(/\.csv$/i, ''),
    perCell: Number(req.body.perCell) || 5,
    seed: req.body.seed ? Number(req.body.seed) : undefined
  })
  res.json(result)
}))

app.post('/api/runs/:id/sample', handle(async (req, res) => {
  const runId = Number(req.params.id)
  if (isRunActive(runId)) return res.status(409).json({ error: 'Stop the run before resampling' })
  const perCell = Number(req.body?.perCell)
  if (!perCell || perCell < 1) return res.status(400).json({ error: 'perCell must be >= 1' })
  res.json(sampleRun({ runId, perCell, seed: req.body?.seed ? Number(req.body.seed) : undefined }))
}))

app.put('/api/runs/:id/settings', handle(async (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id)
  if (!run) return res.status(404).json({ error: 'Run not found' })
  const { workflowId, ...patch } = req.body || {}
  const next = { ...JSON.parse(run.settings_json || '{}'), ...patch }
  db.prepare('UPDATE runs SET settings_json = ?, workflow_id = COALESCE(?, workflow_id) WHERE id = ?').run(JSON.stringify(next), workflowId || null, run.id)
  res.json({ ok: true, settings: next })
}))

app.post('/api/runs/:id/start', handle(async (req, res) => {
  const runId = Number(req.params.id)
  if (isRunActive(runId)) return res.status(409).json({ error: 'Run already in progress' })
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!run) return res.status(404).json({ error: 'Run not found' })
  const workflowId = Number(req.body?.workflowId) || run.workflow_id || null
  const settings = { ...JSON.parse(run.settings_json || '{}'), ...(req.body?.settings || {}) }
  db.prepare('UPDATE runs SET workflow_id = ?, settings_json = ? WHERE id = ?').run(workflowId, JSON.stringify(settings), runId)
  const { byMode } = resolveWorkflows({ ...run, workflow_id: workflowId, settings_json: JSON.stringify(settings) })
  if (!Object.values(byMode).some(Boolean)) return res.status(400).json({ error: 'Upload a workflow first' })
  const lowDisk = await lowDiskReason()
  if (lowDisk) return res.status(507).json({ error: `Not starting: ${lowDisk}. Free space (delete old runs) and try again.` })
  if (!(await comfy.ping())) return res.status(503).json({ error: `ComfyUI is not reachable at ${config.COMFY_URL}` })
  runPending({ runId }).then(
    (r) => console.log(`[run ${runId}] finished: ${JSON.stringify(r)}`),
    (err) => console.error(`[run ${runId}] failed: ${err.message}`)
  )
  res.json({ started: true, runId })
}))

app.post('/api/runs/:id/stop', handle(async (req, res) => {
  const runId = Number(req.params.id)
  if (!requestStop(runId)) return res.status(409).json({ error: 'Run is not in progress' })
  await interruptComfy()
  res.json({ stopping: true, runId })
}))

app.post('/api/runs/:id/reset-failed', (req, res) => {
  const result = db.prepare("UPDATE instances SET status = 'pending', error = NULL WHERE run_id = ? AND status IN ('failed', 'unsupported')").run(req.params.id)
  res.json({ reset: result.changes })
})

app.delete('/api/runs/:id', (req, res) => {
  const runId = Number(req.params.id)
  if (isRunActive(runId)) return res.status(409).json({ error: 'Stop the run before deleting it' })
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!run) return res.status(404).json({ error: 'Run not found' })
  const instances = db.prepare('SELECT output_path, prod_video_path FROM instances WHERE run_id = ?').all(runId)
  db.transaction(() => {
    db.prepare('DELETE FROM instances WHERE run_id = ?').run(runId)
    db.prepare('DELETE FROM runs WHERE id = ?').run(runId)
  })()
  let files = 0
  const stillUsed = (column, value) => db.prepare(`SELECT 1 FROM instances WHERE ${column} = ? LIMIT 1`).get(value)
  for (const i of instances) {
    for (const [column, dir] of [['output_path', config.OUTPUTS_DIR], ['prod_video_path', config.PROD_DIR]]) {
      const name = i[column]
      if (!name || stillUsed(column, name)) continue
      try {
        fs.unlinkSync(path.join(dir, name))
        files += 1
      } catch {
        // already gone
      }
    }
  }
  if (run.csv_path.startsWith(config.CSV_DIR) && !db.prepare('SELECT 1 FROM runs WHERE csv_path = ? LIMIT 1').get(run.csv_path)) {
    try {
      fs.unlinkSync(run.csv_path)
    } catch {
      // already gone
    }
  }
  res.json({ deleted: runId, files })
})

app.get('/api/runs/:id/export.csv', (req, res) => {
  res.setHeader('content-type', 'text/csv; charset=utf-8')
  res.setHeader('content-disposition', `attachment; filename="video-compare-run-${req.params.id}.csv"`)
  res.send(exportInstancesCsv(Number(req.params.id)))
})

app.get('/api/runs/:id/summary.csv', (req, res) => {
  res.setHeader('content-type', 'text/csv; charset=utf-8')
  res.setHeader('content-disposition', `attachment; filename="video-compare-run-${req.params.id}-summary.csv"`)
  res.send(exportSummaryCsv(Number(req.params.id)))
})

// ---- instances ----

const authorOf = (req) => String(req.body?.author || req.get('x-user') || '').trim().slice(0, 60)

app.post('/api/instances/:id/rating', (req, res) => {
  const { rating } = req.body || {}
  if (![null, 'prod', 'local', 'tie'].includes(rating)) return res.status(400).json({ error: 'rating must be prod|local|tie|null' })
  const author = rating ? authorOf(req) || null : null
  const result = db.prepare("UPDATE instances SET rating = ?, rated_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END, rated_by = ? WHERE id = ?").run(rating, rating, author, req.params.id)
  if (!result.changes) return res.status(404).json({ error: 'Instance not found' })
  res.json({ ok: true })
})

// ---- comments (per user; the author is whatever name the browser sends) ----

// two threads per row: one about the production clip, one about the local (new workflow) clip
app.get('/api/instances/:id/comments', (req, res) => {
  const rows = db.prepare('SELECT id, side, author, body, created_at FROM comments WHERE instance_id = ? ORDER BY id').all(req.params.id)
  res.json(req.query.side ? rows.filter((c) => c.side === req.query.side) : rows)
})

app.post('/api/instances/:id/comments', (req, res) => {
  const author = authorOf(req)
  const body = String(req.body?.body || '').trim().slice(0, 4000)
  const side = req.body?.side === 'prod' ? 'prod' : 'local'
  if (!author) return res.status(400).json({ error: 'Set your name first (top right)' })
  if (!body) return res.status(400).json({ error: 'Empty comment' })
  if (!db.prepare('SELECT id FROM instances WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Instance not found' })
  const { lastInsertRowid } = db.prepare('INSERT INTO comments (instance_id, side, author, body) VALUES (?, ?, ?, ?)').run(req.params.id, side, author, body)
  res.json(db.prepare('SELECT id, side, author, body, created_at FROM comments WHERE id = ?').get(lastInsertRowid))
})

app.delete('/api/comments/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Comment not found' })
  if (row.author !== authorOf(req)) return res.status(403).json({ error: 'Only the author can delete a comment' })
  db.prepare('DELETE FROM comments WHERE id = ?').run(row.id)
  res.json({ ok: true })
})

app.post('/api/instances/:id/note', (req, res) => {
  const note = String(req.body?.note ?? '').slice(0, 2000) || null
  db.prepare('UPDATE instances SET note = ? WHERE id = ?').run(note, req.params.id)
  res.json({ ok: true })
})

app.post('/api/instances/:id/retry', (req, res) => {
  const result = db.prepare("UPDATE instances SET status = 'pending', error = NULL WHERE id = ? AND status IN ('failed', 'unsupported', 'done')").run(req.params.id)
  res.json({ reset: result.changes })
})

// dry run: the exact graph that would be sent to ComfyUI for this instance
app.get('/api/instances/:id/graph', handle(async (req, res) => {
  const instance = db.prepare('SELECT * FROM instances WHERE id = ?').get(req.params.id)
  if (!instance) return res.status(404).json({ error: 'Instance not found' })
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(instance.run_id)
  let workflow = null
  if (req.query.workflowId) {
    const w = db.prepare('SELECT * FROM workflows WHERE id = ?').get(Number(req.query.workflowId))
    workflow = w && hydrate(w)
  } else workflow = resolveWorkflows(run).byMode[instance.mode]
  if (!workflow) return res.status(400).json({ error: `No workflow serves mode ${instance.mode}` })
  const settings = settingsOf(run)
  const dryClient = { getObjectInfo: () => comfy.getObjectInfo().catch(() => ({})), uploadFile: async ({ filename }) => `(upload) ${filename}` }
  const { graph, values } = await prepareGraph({ client: dryClient, instance, workflow, settings, seed: instance.seed ?? 12345 })
  res.json({ workflow: { id: workflow.id, name: workflow.name }, values, graph })
}))

app.listen(config.PORT, config.HOST, async () => {
  console.log(`video-compare: http://${config.HOST}:${config.PORT} (ComfyUI ${config.COMFY_URL})`)
  const bins = await getBinaries()
  console.log(`[media] ffmpeg: ${bins.ffmpeg || 'none'} · ffprobe: ${bins.ffprobe || 'none'}`)
  // fill in posters for clips generated before thumbnails existed (or while ffmpeg was missing)
  if (bins.ffmpeg) backfillThumbnails().then((r) => r.candidates && console.log(`[thumbs] backfill: ${JSON.stringify(r)}`))
  startWatchdog()
})

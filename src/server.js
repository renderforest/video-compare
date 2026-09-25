import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import db from './db.js'
import config from './config.js'
import { importCsv, sampleRun, coverage } from './scenario.js'
import { runPending, isRunActive, requestStop, interruptComfy, currentProgress, prepareGraph } from './runner.js'
import { parseWorkflowUpload, sha1, capabilities, detectBindings, missingClasses } from './workflow.js'
import { exportInstancesCsv, exportSummaryCsv } from './export.js'
import { ComfyClient } from './comfy.js'
import { MODES, QUALITIES } from './csv.js'

const app = express()
app.use(express.json({ limit: '5mb' }))
app.use(express.static(path.join(config.ROOT, 'public')))
for (const dir of [config.OUTPUTS_DIR, config.PROD_DIR, config.INPUTS_DIR, config.CSV_DIR]) fs.mkdirSync(dir, { recursive: true })
app.use('/outputs', express.static(config.OUTPUTS_DIR, { acceptRanges: true }))
app.use('/prod', express.static(config.PROD_DIR, { acceptRanges: true }))
app.use('/inputs', express.static(config.INPUTS_DIR))

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

const withStats = (run) => ({ ...run, settings: JSON.parse(run.settings_json || '{}'), ...runStats.get(run.id), active: isRunActive(run.id) })

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
}

// ---- health ----

app.get('/api/health', handle(async (req, res) => {
  res.json({ ok: true, comfyUrl: config.COMFY_URL, comfyReachable: await comfy.ping(), publicBaseUrl: config.PUBLIC_BASE_URL, defaults: { qualityMegapixels: config.DEFAULT_QUALITY_MEGAPIXELS, modes: MODES, qualities: QUALITIES } })
}))

// ---- workflows ----

app.get('/api/workflows', (req, res) => {
  const rows = db.prepare('SELECT id, name, sha1, bindings_json, created_at FROM workflows ORDER BY id DESC').all()
  res.json(rows.map((w) => {
    const bindings = JSON.parse(w.bindings_json)
    return { id: w.id, name: w.name, sha1: w.sha1, createdAt: w.created_at, bindings, capabilities: capabilities(bindings) }
  }))
})

app.get('/api/workflows/:id', handle(async (req, res) => {
  const w = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
  if (!w) return res.status(404).json({ error: 'Workflow not found' })
  const graph = JSON.parse(w.json)
  const bindings = JSON.parse(w.bindings_json)
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
  const { lastInsertRowid } = db.prepare('INSERT INTO workflows (name, json, bindings_json, sha1) VALUES (?, ?, ?, ?)').run(name, json, JSON.stringify(bindings), sha1(json))
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
  db.prepare('UPDATE workflows SET bindings_json = ? WHERE id = ?').run(JSON.stringify(bindings), w.id)
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

app.get('/api/runs/:id/instances', (req, res) => {
  const all = req.query.all === '1'
  const rows = db
    .prepare(`SELECT * FROM instances WHERE run_id = ? ${all ? '' : 'AND sampled = 1'} ORDER BY scenario_key, id`)
    .all(req.params.id)
    .map((i) => ({ ...i, progress: i.status === 'running' ? currentProgress(i.id) : null }))
  res.json(rows)
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
  const workflowId = Number(req.body?.workflowId) || run.workflow_id
  if (!workflowId || !db.prepare('SELECT id FROM workflows WHERE id = ?').get(workflowId)) {
    return res.status(400).json({ error: 'Select or upload a workflow first' })
  }
  const settings = { ...JSON.parse(run.settings_json || '{}'), ...(req.body?.settings || {}) }
  db.prepare('UPDATE runs SET workflow_id = ?, settings_json = ? WHERE id = ?').run(workflowId, JSON.stringify(settings), runId)
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

app.post('/api/instances/:id/rating', (req, res) => {
  const { rating } = req.body || {}
  if (![null, 'prod', 'local', 'tie'].includes(rating)) return res.status(400).json({ error: 'rating must be prod|local|tie|null' })
  const result = db.prepare("UPDATE instances SET rating = ?, rated_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END WHERE id = ?").run(rating, rating, req.params.id)
  if (!result.changes) return res.status(404).json({ error: 'Instance not found' })
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
  const workflowId = Number(req.query.workflowId) || run.workflow_id
  const w = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
  if (!w) return res.status(400).json({ error: 'No workflow selected' })
  const workflow = { ...w, graph: JSON.parse(w.json), bindings: JSON.parse(w.bindings_json) }
  const settings = { qualityMegapixels: { ...config.DEFAULT_QUALITY_MEGAPIXELS, ...(JSON.parse(run.settings_json || '{}').qualityMegapixels || {}) } }
  const dryClient = { getObjectInfo: () => comfy.getObjectInfo().catch(() => ({})), uploadFile: async ({ filename }) => `(upload) ${filename}` }
  const { graph, values } = await prepareGraph({ client: dryClient, instance, workflow, settings, seed: instance.seed ?? 12345 })
  res.json({ values, graph })
}))

app.listen(config.PORT, config.HOST, () => console.log(`video-compare: http://${config.HOST}:${config.PORT} (ComfyUI ${config.COMFY_URL})`))

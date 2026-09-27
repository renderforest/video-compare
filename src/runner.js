import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import db from './db.js'
import config from './config.js'
import { ComfyClient, fetchRetry } from './comfy.js'
import { probeVideo } from './media.js'
import { emit } from './hooks.js'
import { lowDiskReason } from './disk.js'
import { computeDims } from './dims.js'
import { sha1, capabilities, unsupportedReason, assignMedia, buildPrompt, pruneEmptySlots, missingClasses, MODES, DETECTOR_VERSION, detectBindings } from './workflow.js'

const activeRuns = new Set()
const stopRequests = new Set()
const progress = new Map() // instanceId → { value, max, node }
const stopReasons = new Map() // runId → why the last run loop ended early (e.g. low disk)

export const runStopReason = (runId) => stopReasons.get(runId) || null

export const isRunActive = (runId) => activeRuns.has(runId)
export const currentProgress = (instanceId) => progress.get(instanceId) || null

/** Returns true if the run was active and will stop after the current instance. */
export const requestStop = (runId) => {
  if (!activeRuns.has(runId)) return false
  stopRequests.add(runId)
  db.prepare("UPDATE runs SET wanted_active = 0, last_stop = 'stopped by a user at ' || datetime('now') || ' UTC' WHERE id = ?").run(runId)
  return true
}

// ---- asset cache ----

export const urlCacheName = (url, fallbackExt = '') => {
  let ext = ''
  try {
    ext = path.extname(new URL(url).pathname)
  } catch {
    ext = ''
  }
  return `${sha1(url)}${ext || fallbackExt}`
}

/** Downloads a URL into dir once (streamed); later calls reuse the cached file. */
export const fetchCached = async ({ url, dir, fallbackExt = '' }) => {
  const filename = urlCacheName(url, fallbackExt)
  const filePath = path.join(dir, filename)
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return { filePath, filename }
  fs.mkdirSync(dir, { recursive: true })
  const response = await fetchRetry(url, {}, { attempts: 3, action: 'download', timeoutMs: 5 * 60 * 1000 })
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`)
  const tmp = `${filePath}.part`
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmp))
  fs.renameSync(tmp, filePath)
  return { filePath, filename }
}

const mediaUrls = (instance) => [
  instance.first_frame_url,
  instance.last_frame_url,
  instance.audio_url,
  ...JSON.parse(instance.ref_images_json || '[]'),
  ...JSON.parse(instance.ref_audios_json || '[]')
].filter(Boolean)

/** Archives the production video locally (non-fatal: the UI falls back to the URL). */
const cacheProdVideo = async (instance) => {
  if (instance.prod_video_path && fs.existsSync(path.join(config.PROD_DIR, instance.prod_video_path))) return
  try {
    const { filename, filePath } = await fetchCached({ url: instance.prod_video_url, dir: config.PROD_DIR, fallbackExt: '.mp4' })
    // the same production clip may be cached for several rows (re-sampled runs): tag them all
    db.prepare('UPDATE instances SET prod_video_path = ? WHERE id = ? OR prod_video_url = ?').run(filename, instance.id, instance.prod_video_url)
    await emit('prod:cached', { instance: { ...instance, prod_video_path: filename }, filePath })
  } catch (err) {
    console.error(`[run] prod video download failed for instance ${instance.id}: ${err.message}`)
  }
}

/** Downloads every input + production video up front (6 parallel, deduped). */
export const prefetchAssets = async (instances, { onProgress = () => {} } = {}) => {
  const jobs = []
  for (const i of instances) {
    for (const url of mediaUrls(i)) jobs.push({ url, dir: config.INPUTS_DIR })
    if (!i.prod_video_path) jobs.push({ url: i.prod_video_url, dir: config.PROD_DIR, fallbackExt: '.mp4' })
  }
  const seen = new Set()
  const unique = jobs.filter((j) => !seen.has(j.url) && seen.add(j.url))
  let failed = 0
  let idx = 0
  let done = 0
  await Promise.all(
    Array.from({ length: Math.min(6, unique.length) }, async () => {
      while (idx < unique.length) {
        const job = unique[idx++]
        try {
          await fetchCached(job)
        } catch {
          failed += 1
        }
        done += 1
        onProgress({ done, total: unique.length })
      }
    })
  )
  return { total: unique.length, failed }
}

// ---- checks ----

const runChecks = ({ probe, instance }) => {
  const checks = []
  if (probe.duration != null) {
    const ok = Math.abs(probe.duration - instance.duration) <= 1.5
    checks.push({ name: 'duration', ok, detail: `${probe.duration}s vs ${instance.duration}s requested` })
  }
  if (probe.hasAudio != null) {
    checks.push({ name: 'audio', ok: probe.hasAudio, detail: probe.hasAudio ? 'audio track present' : 'no audio track' })
  }
  if (probe.width && probe.height) {
    const expectPortrait = instance.aspect === '9:16'
    const expectSquare = instance.aspect === '1:1'
    const ratio = probe.width / probe.height
    const ok = expectSquare ? Math.abs(ratio - 1) < 0.1 : expectPortrait ? ratio < 1 : ratio > 1
    checks.push({ name: 'aspect', ok, detail: `${probe.width}x${probe.height} for ${instance.aspect}` })
  }
  return checks
}

// ---- generation ----

export const settingsOf = (run) => {
  let settings = {}
  try {
    settings = JSON.parse(run.settings_json || '{}')
  } catch {
    settings = {}
  }
  return { qualityMegapixels: { ...config.DEFAULT_QUALITY_MEGAPIXELS, ...(settings.qualityMegapixels || {}) }, ...settings }
}

/** Loads a workflow row; bindings detected by an older detector are re-detected once and saved. */
export const hydrate = (row) => {
  const graph = JSON.parse(row.json)
  let bindings = JSON.parse(row.bindings_json)
  if ((row.detector_version || 1) < DETECTOR_VERSION) {
    bindings = detectBindings(graph).bindings
    db.prepare('UPDATE workflows SET bindings_json = ?, detector_version = ? WHERE id = ?').run(JSON.stringify(bindings), DETECTOR_VERSION, row.id)
  }
  return { ...row, graph, bindings, caps: capabilities(bindings) }
}

const loadWorkflow = (workflowId) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
  if (!row) throw new Error(`Workflow #${workflowId} not found`)
  return hydrate(row)
}

/**
 * Which workflow serves each mode for a run: an explicit per-mode choice
 * (settings.workflowsByMode), else the run's default workflow when it supports
 * the mode, else the newest uploaded workflow that does. Null = nothing can.
 * @returns {{ byMode: Record<string, object|null>, sources: Record<string, string|null> }}
 */
export const resolveWorkflows = (run) => {
  const all = db.prepare('SELECT * FROM workflows ORDER BY id DESC').all().map(hydrate)
  const byId = new Map(all.map((w) => [w.id, w]))
  const settings = settingsOf(run)
  const explicit = settings.workflowsByMode || {}
  const fallback = run.workflow_id ? byId.get(run.workflow_id) : null
  const byMode = {}
  const sources = {}
  for (const mode of MODES) {
    const chosen = explicit[mode] ? byId.get(Number(explicit[mode])) : null
    if (chosen) {
      byMode[mode] = chosen
      sources[mode] = 'explicit'
    } else if (fallback && fallback.caps.modes[mode]) {
      byMode[mode] = fallback
      sources[mode] = 'default'
    } else {
      const auto = all.find((w) => w.caps.modes[mode])
      byMode[mode] = auto || null
      sources[mode] = auto ? 'auto' : null
    }
  }
  return { byMode, sources }
}


/** Every value a binding may ask for, for this instance. */
export const valuesFor = ({ instance, settings, seed }) => {
  const hasImage = instance.mode !== 't2v'
  const dims = computeDims({ quality: instance.quality, aspect: instance.aspect, duration: instance.duration, hasImage })
  return {
    prompt: instance.prompt,
    seed,
    duration: instance.duration,
    frames: dims.adjustedFrameCount,
    frames_minimax: dims.minimaxFrameCount,
    aspect: instance.aspect,
    aspect_ratio: instance.aspect,
    megapixels: settings.qualityMegapixels[instance.quality] ?? settings.qualityMegapixels[720],
    quality: instance.quality,
    width: dims.width,
    height: dims.height,
    crop_width: dims.cropWidth,
    crop_height: dims.cropHeight,
    upscale_factor: dims.upscaleFactor,
    fps: dims.fps,
    frame_count: dims.frameCount,
    adjusted_frame_count: dims.adjustedFrameCount,
    audio_start_time: instance.audio_start ?? 0,
    watermark: false,
    enable_watermark: false,
    output_prefix: `vc_${instance.id}`
  }
}

const genKeyFor = ({ instance, workflow, values }) =>
  sha1([workflow.sha1, instance.mode, JSON.stringify(values), instance.first_frame_url, instance.last_frame_url, instance.audio_url, instance.ref_images_json, instance.ref_audios_json].join('|'))

const findReusable = ({ genKey, instanceId }) => {
  const rows = db
    .prepare("SELECT id, output_path, seed, duration_ms, probe_json, checks_json, output_thumb FROM instances WHERE gen_key = ? AND status = 'done' AND output_path IS NOT NULL AND id != ? ORDER BY id DESC")
    .all(genKey, instanceId)
  return rows.find((r) => fs.existsSync(path.join(config.OUTPUTS_DIR, r.output_path))) || null
}

/** Builds the final graph for an instance (also used by the CLI `inspect` for dry runs). */
export const prepareGraph = async ({ client, instance, workflow, settings, seed }) => {
  const values = valuesFor({ instance, settings, seed })
  const frameBinding = workflow.bindings.find((b) => b.key === 'frames')
  if (frameBinding?.kind === 'minimax') values.frames = values.frames_minimax

  const { images, audios } = assignMedia({ bindings: workflow.bindings, instance })
  for (const b of workflow.bindings) {
    if (/^(image|audio)(_url)?_\d+$/.test(b.key)) values[b.key] = ''
  }
  for (const { binding, url } of [...images, ...audios]) {
    if (binding.key.includes('_url_')) {
      values[binding.key] = url
    } else {
      const isAudio = binding.key.startsWith('audio')
      const { filePath, filename } = await fetchCached({ url, dir: config.INPUTS_DIR, fallbackExt: isAudio ? '.mp3' : '.jpg' })
      values[binding.key] = await client.uploadFile({ filePath, filename, contentType: isAudio ? 'audio/mpeg' : 'image/jpeg' })
    }
  }

  const objectInfo = await client.getObjectInfo()
  const graph = pruneEmptySlots({
    graph: buildPrompt({ template: workflow.graph, bindings: workflow.bindings, values, objectInfo }),
    bindings: workflow.bindings,
    objectInfo
  })
  return { graph, values }
}

// ComfyUI keeps its own copy of every clip in its output folder (same disk on the worker);
// once we hold the file, ours is removed there. Only files with our prefix are touched.
const removeComfyCopy = ({ filename, subfolder = '' }) => {
  if (!config.COMFY_OUTPUT_DIR || !/^vc_/.test(filename)) return
  const target = path.join(config.COMFY_OUTPUT_DIR, subfolder, filename)
  try {
    fs.unlinkSync(target)
  } catch {
    // not on this machine or already gone
  }
}

const generateInstance = async ({ client, instance, workflow, settings, seed }) => {
  const { graph } = await prepareGraph({ client, instance, workflow, settings, seed })
  const promptId = await client.queuePrompt(graph)
  db.prepare('UPDATE instances SET comfy_prompt_id = ? WHERE id = ?').run(promptId, instance.id)

  await client.waitForCompletion(promptId, { onProgress: (p) => progress.set(instance.id, p) })
  const output = await client.findVideoOutput(promptId)
  fs.mkdirSync(config.OUTPUTS_DIR, { recursive: true })
  const ext = path.extname(output.filename) || '.mp4'
  const outName = `${instance.id}_${sha1(promptId).slice(0, 8)}${ext}`
  await client.downloadToFile({ ...output, destPath: path.join(config.OUTPUTS_DIR, outName) })
  removeComfyCopy(output)
  const probe = await probeVideo({ filePath: path.join(config.OUTPUTS_DIR, outName), meta: output })
  return { outName, probe, checks: runChecks({ probe, instance }) }
}

/**
 * Generates every sampled instance of the run that is not done yet, one at a time.
 * Safe to call again after a crash: 'running' rows are retried, done rows are kept.
 */
export const runPending = async ({ runId, onProgress = () => {} }) => {
  if (activeRuns.has(runId)) throw new Error(`Run ${runId} is already in progress`)
  activeRuns.add(runId)
  // remembered across restarts: a run that was active when the server died is resumed on boot
  db.prepare('UPDATE runs SET wanted_active = 1, last_stop = NULL WHERE id = ?').run(runId)
  try {
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
    if (!run) throw new Error(`Run ${runId} not found`)
    const { byMode } = resolveWorkflows(run)
    const used = [...new Set(Object.values(byMode).filter(Boolean))]
    if (!used.length) throw new Error('No workflow uploaded')
    const settings = settingsOf(run)

    const client = new ComfyClient({ baseUrl: config.COMFY_URL, timeoutMs: config.JOB_TIMEOUT_MS, pollIntervalMs: config.POLL_INTERVAL_MS })
    if (!(await client.ping())) throw new Error(`ComfyUI is not reachable at ${config.COMFY_URL}`)
    const objectInfo = await client.getObjectInfo({ force: true })
    for (const w of used) {
      const missing = missingClasses({ graph: w.graph, objectInfo })
      if (missing.length) throw new Error(`ComfyUI is missing node classes used by workflow "${w.name}": ${missing.join(', ')}`)
    }

    const pending = db
      .prepare("SELECT * FROM instances WHERE run_id = ? AND sampled = 1 AND status IN ('pending', 'failed', 'running', 'unsupported') ORDER BY id")
      .all(runId)

    // pick a workflow per row; mark what no workflow can replay so the loop and the UI skip it
    const setUnsupported = db.prepare("UPDATE instances SET status = 'unsupported', error = ?, workflow_id = ? WHERE id = ?")
    const setPending = db.prepare("UPDATE instances SET status = 'pending', error = NULL WHERE id = ?")
    const runnable = []
    for (const instance of pending) {
      const workflow = byMode[instance.mode]
      const reason = workflow ? unsupportedReason({ caps: workflow.caps, instance }) : `no uploaded workflow supports mode ${instance.mode}`
      if (reason) setUnsupported.run(reason, workflow?.id || null, instance.id)
      else {
        if (instance.status === 'unsupported') setPending.run(instance.id)
        runnable.push({ ...instance, workflow })
      }
    }

    stopReasons.delete(runId)
    const lowBeforePrefetch = await lowDiskReason()
    if (lowBeforePrefetch) {
      stopReasons.set(runId, lowBeforePrefetch)
      throw new Error(lowBeforePrefetch)
    }
    const prefetch = await prefetchAssets(runnable, { onProgress: (p) => onProgress({ phase: 'prefetch', ...p }) })
    console.log(`[run ${runId}] prefetched ${prefetch.total - prefetch.failed}/${prefetch.total} assets${prefetch.failed ? ` (${prefetch.failed} failed, retried per instance)` : ''}`)

    await client.connect()
    const setStatus = db.prepare('UPDATE instances SET status = ?, error = ?, output_path = ?, duration_ms = ?, probe_json = ?, checks_json = ?, workflow_id = ?, attempt = ? WHERE id = ?')
    let done = 0
    let failed = 0
    let reused = 0
    let stopped = false
    try {
      for (const instance of runnable) {
        const { workflow } = instance
        if (stopRequests.has(runId)) {
          stopped = true
          break
        }
        const lowDisk = await lowDiskReason()
        if (lowDisk) {
          console.error(`[run ${runId}] pausing: ${lowDisk}`)
          stopReasons.set(runId, lowDisk)
          stopped = true
          break
        }
        // a fixed seed per instance: retries and re-runs reproduce the same clip
        const seed = instance.seed ?? crypto.randomInt(0, 2 ** 31)
        db.prepare("UPDATE instances SET seed = ?, status = 'running', error = NULL WHERE id = ?").run(seed, instance.id)
        onProgress({ phase: 'generate', instanceId: instance.id, status: 'running' })
        await cacheProdVideo(instance)

        const values = valuesFor({ instance, settings, seed })
        const genKey = genKeyFor({ instance, workflow, values })
        db.prepare('UPDATE instances SET gen_key = ? WHERE id = ?').run(genKey, instance.id)
        const reusable = findReusable({ genKey, instanceId: instance.id })
        if (reusable) {
          db.prepare("UPDATE instances SET status = 'done', error = NULL, output_path = ?, duration_ms = ?, probe_json = ?, checks_json = ?, reused = 1, workflow_id = ?, output_thumb = ? WHERE id = ?")
            .run(reusable.output_path, reusable.duration_ms, reusable.probe_json, reusable.checks_json, workflow.id, reusable.output_thumb, instance.id)
          done += 1
          reused += 1
          onProgress({ phase: 'generate', instanceId: instance.id, status: 'done' })
          continue
        }

        const startedAt = Date.now()
        let lastError = null
        let attempt = 0
        for (attempt = 1; attempt <= 2; attempt += 1) {
          try {
            await client.connect()
            const result = await generateInstance({ client, instance, workflow, settings, seed })
            setStatus.run('done', null, result.outName, Date.now() - startedAt, JSON.stringify(result.probe), JSON.stringify(result.checks), workflow.id, attempt, instance.id)
            done += 1
            lastError = null
            await emit('generation:finished', { instance, outputPath: path.join(config.OUTPUTS_DIR, result.outName) })
            break
          } catch (err) {
            lastError = err
            console.error(`[run ${runId}] instance ${instance.id} attempt ${attempt} failed: ${err.message}`)
            if (stopRequests.has(runId)) break
          }
        }
        progress.delete(instance.id)
        if (lastError && stopRequests.has(runId)) {
          setStatus.run('pending', null, null, null, null, null, workflow.id, attempt, instance.id)
          onProgress({ phase: 'generate', instanceId: instance.id, status: 'pending' })
          stopped = true
          break
        }
        if (lastError) {
          setStatus.run('failed', String(lastError.message || lastError), null, Date.now() - startedAt, null, null, workflow.id, attempt, instance.id)
          failed += 1
        }
        onProgress({ phase: 'generate', instanceId: instance.id, status: lastError ? 'failed' : 'done' })
      }
    } finally {
      client.close()
    }
    const summary = { runId, processed: runnable.length, unsupported: pending.length - runnable.length, done, failed, reused, stopped, workflows: used.map((w) => w.name) }
    const reason = stopReasons.get(runId)
    if (reason) {
      // paused by a guard (e.g. low disk): stay "wanted", the watchdog resumes it once the cause clears
      db.prepare('UPDATE runs SET last_stop = ? WHERE id = ?').run(`${reason} (at ${new Date().toISOString()})`, runId)
    } else if (!stopped) {
      db.prepare("UPDATE runs SET wanted_active = 0, last_stop = 'finished at ' || datetime('now') || ' UTC' WHERE id = ?").run(runId)
    }
    await emit('run:finished', { runId, summary })
    return summary
  } catch (err) {
    // unexpected error: keep the run wanted so the watchdog retries; the reason is visible in the UI
    db.prepare('UPDATE runs SET last_stop = ? WHERE id = ?').run(`error: ${err.message} (at ${new Date().toISOString()})`, runId)
    throw err
  } finally {
    activeRuns.delete(runId)
    stopRequests.delete(runId)
  }
}

export const interruptComfy = () => new ComfyClient({ baseUrl: config.COMFY_URL }).interrupt()

const pendingCount = db.prepare("SELECT COUNT(*) AS c FROM instances WHERE run_id = ? AND sampled = 1 AND status IN ('pending', 'failed', 'running')")

/**
 * Starts every run that should be active but is not: after a restart, after a guard pause,
 * or after an error. Only an explicit Stop (wanted_active = 0) or no pending rows ends it.
 */
export const resumeWantedRuns = ({ delayMs = 5000, label = 'resume' } = {}) => {
  const runs = db.prepare('SELECT id, name FROM runs WHERE wanted_active = 1').all().filter((r) => !activeRuns.has(r.id))
  for (const run of runs) {
    if (!pendingCount.get(run.id).c) {
      db.prepare("UPDATE runs SET wanted_active = 0, last_stop = 'finished at ' || datetime('now') || ' UTC' WHERE id = ?").run(run.id)
      continue
    }
    console.log(`[${label}] run ${run.id} "${run.name}" should be running — starting in ${delayMs / 1000}s`)
    setTimeout(() => {
      runPending({ runId: run.id }).then(
        (r) => console.log(`[run ${run.id}] finished: ${JSON.stringify(r)}`),
        (err) => console.error(`[run ${run.id}] ${label} failed: ${err.message}`)
      )
    }, delayMs)
  }
  return runs.length
}

/** Boot: resume immediately; then keep checking every `intervalMs`. */
export const startWatchdog = ({ intervalMs = 5 * 60 * 1000 } = {}) => {
  resumeWantedRuns({ label: 'resume' })
  setInterval(() => resumeWantedRuns({ delayMs: 1000, label: 'watchdog' }), intervalMs)
}

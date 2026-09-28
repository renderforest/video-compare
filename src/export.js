import { stringify } from 'csv-stringify/sync'
import db from './db.js'
import config from './config.js'
import { coverage } from './scenario.js'

const localUrl = (instance) => (instance.output_path ? `${config.PUBLIC_BASE_URL}/outputs/${encodeURIComponent(instance.output_path)}` : '')

/** One line per sampled instance: inputs, scenario, outcome, rating. */
export const exportInstancesCsv = (runId) => {
  const rows = db
    .prepare('SELECT * FROM instances WHERE run_id = ? AND sampled = 1 ORDER BY finished_at IS NULL, finished_at, id')
    .all(runId)
    .map((i) => {
      const probe = i.probe_json ? JSON.parse(i.probe_json) : {}
      const checks = i.checks_json ? JSON.parse(i.checks_json) : []
      return {
        instanceId: i.id,
        sourceId: i.source_id,
        createdAt: i.created_at_src,
        userId: i.user_id,
        videoModel: i.video_model,
        scenario: i.scenario_key,
        mode: i.mode,
        quality: i.quality,
        aspectRatio: i.aspect,
        aspectSource: i.aspect_source,
        duration: i.duration,
        durationBucket: i.duration_bucket,
        styleId: i.style_id,
        styleName: i.style_name,
        videoType: i.video_type_name || i.video_type,
        flow: i.flow,
        prompt: i.prompt,
        firstFrameUrl: i.first_frame_url,
        lastFrameUrl: i.last_frame_url,
        voiceOverUrl: i.audio_url,
        audioStartTime: i.audio_start,
        referenceImages: JSON.parse(i.ref_images_json || '[]').join('|'),
        referenceAudios: JSON.parse(i.ref_audios_json || '[]').join('|'),
        prodVideoUrl: i.prod_video_url,
        localVideoUrl: localUrl(i),
        localThumbUrl: i.output_thumb ? `${config.PUBLIC_BASE_URL}/thumbs/${encodeURIComponent(i.output_thumb)}` : '',
        prodThumbUrl: i.prod_thumb ? `${config.PUBLIC_BASE_URL}/thumbs/${encodeURIComponent(i.prod_thumb)}` : '',
        status: i.status,
        error: i.error,
        seed: i.seed,
        workflowId: i.workflow_id,
        reused: i.reused,
        generatedAt: i.finished_at,
        generationMs: i.duration_ms,
        outWidth: probe.width,
        outHeight: probe.height,
        outFps: probe.fps,
        outFrames: probe.frames,
        outDuration: probe.duration,
        outHasAudio: probe.hasAudio,
        outSizeBytes: probe.sizeBytes,
        checksFailed: checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; '),
        rating: i.rating,
        ratedBy: i.rated_by,
        ratedAt: i.rated_at,
        note: i.note,
        prodComments: db.prepare("SELECT author, body, created_at FROM comments WHERE instance_id = ? AND side = 'prod' ORDER BY id").all(i.id).map((c) => `[${c.created_at} ${c.author}] ${c.body}`).join('\n'),
        localComments: db.prepare("SELECT author, body, created_at FROM comments WHERE instance_id = ? AND side = 'local' ORDER BY id").all(i.id).map((c) => `[${c.created_at} ${c.author}] ${c.body}`).join('\n')
      }
    })
  return stringify(rows, { header: true })
}

/** One line per scenario cell with win counts and median generation time. */
export const exportSummaryCsv = (runId) => {
  const medians = new Map()
  for (const row of db
    .prepare("SELECT scenario_key, duration_ms FROM instances WHERE run_id = ? AND sampled = 1 AND status = 'done' AND reused = 0 AND duration_ms IS NOT NULL")
    .all(runId)) {
    if (!medians.has(row.scenario_key)) medians.set(row.scenario_key, [])
    medians.get(row.scenario_key).push(row.duration_ms)
  }
  const median = (arr) => {
    if (!arr?.length) return ''
    const sorted = [...arr].sort((a, b) => a - b)
    return Math.round(sorted[Math.floor(sorted.length / 2)] / 1000)
  }
  const rows = coverage(runId).map((c) => ({
    scenario: c.scenario_key,
    mode: c.mode,
    quality: c.quality,
    aspectRatio: c.aspect,
    durationBucket: c.duration_bucket,
    videoType: c.video_type,
    style: c.style,
    poolRows: c.pool,
    sampled: c.sampled,
    done: c.done,
    failed: c.failed,
    unsupported: c.unsupported,
    rated: c.rated,
    localWins: c.local_wins,
    prodWins: c.prod_wins,
    ties: c.ties,
    localWinRate: c.rated ? Math.round((c.local_wins / c.rated) * 100) / 100 : '',
    medianGenerationSeconds: median(medians.get(c.scenario_key))
  }))
  return stringify(rows, { header: true })
}

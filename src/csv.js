import fs from 'node:fs'
import { parse } from 'csv-parse'
import { classifyAspect } from './dims.js'

export const MODES = ['t2v', 'i2v', 'flf', 'ia2v', 'refi2v']
export const QUALITIES = [480, 720]

// sensible defaults; a run can override via settings.buckets
export const DEFAULT_BUCKETS = [
  { name: '1-3', max: 3 },
  { name: '4-6', max: 6 },
  { name: '7-10', max: 10 },
  { name: '11-15', max: 15 },
  { name: '16+', max: Infinity }
]

const nullish = (value) => {
  const s = String(value ?? '').trim()
  return !s || s.toLowerCase() === 'null' ? null : s
}

const splitUrls = (value) =>
  (nullish(value) || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)

const isHttp = (value) => /^https?:\/\//i.test(value || '')

/** Mode selection copied from ai-workers-service getWorkflowConfig (refs win, then audio, then last frame, then image). */
export const deriveMode = ({ refImages, refAudios, audioUrl, lastFrameUrl, firstFrameUrl }) => {
  if (refImages.length || refAudios.length) return 'refi2v'
  if (audioUrl) return 'ia2v'
  if (lastFrameUrl) return 'flf'
  if (firstFrameUrl) return 'i2v'
  return 't2v'
}

export const durationBucket = (duration, buckets = DEFAULT_BUCKETS) =>
  (buckets.find((b) => duration <= b.max) || buckets[buckets.length - 1]).name

export const styleLabel = (row) => {
  const style = row.style_name || (row.style_id ? `style#${row.style_id}` : 'none')
  return row.video_type_name || row.video_type ? `${row.video_type_name || row.video_type} / ${style}` : style
}

export const scenarioKey = (row) =>
  [row.mode, row.quality, row.aspect, row.duration_bucket, styleLabel(row)].join(' | ')

/**
 * Turns one CSV record (header from docs/export.sql) into an instance row.
 * @returns {{ row?: object, skip?: string }}
 */
export const normalizeRecord = (record, { buckets = DEFAULT_BUCKETS } = {}) => {
  const prompt = nullish(record.prompt) ?? ''
  const prodVideoUrl = nullish(record.videoUrl)
  if (!prodVideoUrl || !isHttp(prodVideoUrl)) return { skip: 'no production video url' }

  const quality = Number(nullish(record.quality)) || 720
  const duration = Number(nullish(record.videoDurationSeconds))
  if (!duration || duration <= 0) return { skip: 'no duration' }

  const firstFrameUrl = nullish(record.firstFrameUrl) || nullish(record.imageUrl)
  const lastFrameUrl = nullish(record.lastFrameUrl)
  const audioUrl = nullish(record.voiceOverUrl)
  const refImages = splitUrls(record.referenceImages)
  const refAudios = splitUrls(record.referenceAudios)
  const mode = deriveMode({ refImages, refAudios, audioUrl, lastFrameUrl, firstFrameUrl })

  const prodWidth = Number(nullish(record.width)) || null
  const prodHeight = Number(nullish(record.height)) || null
  let aspect = nullish(record.aspectRatio)
  let aspectSource = 'row'
  if (!aspect) {
    // image-driven rows have no aspect in the request; the production output's dims tell us what the worker inferred
    aspect = classifyAspect(prodWidth, prodHeight)
    aspectSource = aspect ? 'output' : 'default'
    aspect = aspect || '16:9'
  }

  const row = {
    source_id: nullish(record.id),
    created_at_src: nullish(record.createdAt),
    user_id: nullish(record.userId),
    video_model: nullish(record.videoModel),
    mode,
    quality,
    aspect,
    aspect_source: aspectSource,
    duration,
    duration_bucket: durationBucket(duration, buckets),
    style_id: nullish(record.styleId),
    style_name: nullish(record.styleName),
    video_type: nullish(record.videoType),
    video_type_name: nullish(record.videoTypeName),
    flow: nullish(record.flow),
    prompt,
    first_frame_url: firstFrameUrl,
    last_frame_url: lastFrameUrl,
    audio_url: audioUrl,
    audio_start: audioUrl ? Number(nullish(record.audioStartTime)) || 0 : null,
    ref_images_json: JSON.stringify(refImages),
    ref_audios_json: JSON.stringify(refAudios),
    prod_video_url: prodVideoUrl,
    prod_width: prodWidth,
    prod_height: prodHeight
  }
  row.scenario_key = scenarioKey(row)
  return { row }
}

/** Streams the CSV and returns normalized rows plus skip reasons. */
export const parseCsvFile = (csvPath, options) =>
  new Promise((resolve, reject) => {
    const rows = []
    const skipped = {}
    fs.createReadStream(csvPath)
      .pipe(parse({ columns: true, bom: true, relaxColumnCount: true, skipEmptyLines: true, trim: false }))
      .on('data', (record) => {
        const { row, skip } = normalizeRecord(record, options)
        if (row) rows.push(row)
        else skipped[skip] = (skipped[skip] || 0) + 1
      })
      .on('end', () => resolve({ rows, skipped }))
      .on('error', reject)
  })

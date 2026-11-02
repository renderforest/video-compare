import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import config from './config.js'

const execFileAsync = promisify(execFile)

// system binaries win (they may be newer); the static npm builds are the fallback so
// the GPU box needs no root install
const resolveBinary = async (name, staticPath) => {
  try {
    await execFileAsync(name, ['-version'])
    return name
  } catch {
    return staticPath && fs.existsSync(staticPath) ? staticPath : null
  }
}

let binaries = null
export const getBinaries = async () => {
  if (binaries) return binaries
  const [ffmpegStatic, ffprobeStatic] = await Promise.all([
    import('ffmpeg-static').then((m) => m.default).catch(() => null),
    import('ffprobe-static').then((m) => m.default.path).catch(() => null)
  ])
  binaries = {
    ffmpeg: process.env.FFMPEG_PATH || (await resolveBinary('ffmpeg', ffmpegStatic)),
    ffprobe: process.env.FFPROBE_PATH || (await resolveBinary('ffprobe', ffprobeStatic))
  }
  return binaries
}

/** Stream facts used by the checks; falls back to the save node's own metadata. */
export const probeVideo = async ({ filePath, meta }) => {
  const { ffprobe } = await getBinaries()
  if (ffprobe) {
    try {
      const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath])
      const info = JSON.parse(stdout)
      const video = (info.streams || []).find((s) => s.codec_type === 'video') || {}
      const audio = (info.streams || []).find((s) => s.codec_type === 'audio')
      const [num, den] = String(video.r_frame_rate || '0/1').split('/').map(Number)
      return {
        width: video.width || null,
        height: video.height || null,
        fps: den ? Math.round((num / den) * 100) / 100 : null,
        frames: Number(video.nb_frames) || null,
        duration: Number(info.format?.duration) || null,
        hasAudio: !!audio,
        sizeBytes: Number(info.format?.size) || fs.statSync(filePath).size,
        source: 'ffprobe'
      }
    } catch {
      // fall through to node metadata
    }
  }
  const status = meta?._pixaroma_status || {}
  return {
    width: status.w || null,
    height: status.h || null,
    fps: status.fps || null,
    frames: status.frames || null,
    duration: status.duration || null,
    hasAudio: null,
    sizeBytes: fs.statSync(filePath).size,
    source: 'save-node'
  }
}

export const thumbName = (videoFile) => `${path.parse(videoFile).name}.jpg`

/**
 * Writes a small JPEG poster (default 320 px wide) taken ~0.5 s into the clip.
 * Returns the thumbnail file name, or null when no ffmpeg is available / the clip is unreadable.
 */
export const makeThumbnail = async ({ videoPath, outDir, width = 320, at = 0.5 }) => {
  const { ffmpeg } = await getBinaries()
  if (!ffmpeg) return null
  fs.mkdirSync(outDir, { recursive: true })
  const outName = thumbName(path.basename(videoPath))
  const outPath = path.join(outDir, outName)
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return outName
  const args = (seek) => ['-y', '-v', 'error', '-ss', String(seek), '-i', videoPath, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '5', outPath]
  try {
    await execFileAsync(ffmpeg, args(at), { timeout: 60000 })
  } catch {
    // very short clip: fall back to the first frame
    await execFileAsync(ffmpeg, args(0), { timeout: 60000 })
  }
  return fs.existsSync(outPath) && fs.statSync(outPath).size > 0 ? outName : null
}

export const THUMBS_DIR = path.join(config.DATA_DIR, 'thumbs')

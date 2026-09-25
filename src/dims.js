// Ported from ai-workers-service/src/core/config/config.js (origin/main, 2026-09-23):
// how the production worker turns quality + aspect ratio into MiniMax H3 sizes.

export const FPS = 24
export const ASPECTS = ['16:9', '9:16', '1:1']

// renderforest-pro (MiniMax H3): generates small, latent-upscales by MULTIPLIER, crops to the tier
export const PRO_ASPECT_RATIOS = {
  480: {
    '16:9': { width: 864, height: 480, cropWidth: 854, cropHeight: 480, multiplier: 1 },
    '9:16': { width: 480, height: 864, cropWidth: 480, cropHeight: 854, multiplier: 1 },
    '1:1': { width: 480, height: 480, cropWidth: 480, cropHeight: 480, multiplier: 1 }
  },
  720: {
    '16:9': { width: 1152, height: 640, cropWidth: 1280, cropHeight: 720, multiplier: 1.34 },
    '9:16': { width: 640, height: 1152, cropWidth: 720, cropHeight: 1280, multiplier: 1.34 },
    '1:1': { width: 640, height: 640, cropWidth: 720, cropHeight: 720, multiplier: 1.34 }
  },
  1080: {
    '16:9': { width: 1280, height: 736, cropWidth: 1920, cropHeight: 1080, multiplier: 1.61 },
    '9:16': { width: 736, height: 1280, cropWidth: 1080, cropHeight: 1920, multiplier: 1.61 },
    '1:1': { width: 736, height: 736, cropWidth: 1080, cropHeight: 1080, multiplier: 1.61 }
  }
}

// image-driven modes: the worker only sets the shorter edge
export const PRO_QUALITY_BASED_SIZE = { 480: 480, 720: 640, 1080: 736 }

/** Classifies a width/height pair the way the worker does (tolerance 0.03). */
export const classifyAspect = (width, height) => {
  if (!width || !height) return null
  const ratio = width / height
  const candidates = { '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16 }
  for (const [name, value] of Object.entries(candidates)) {
    if (Math.abs(ratio - value) <= 0.03) return name
  }
  return null
}

/** MiniMax H3 accepts frame counts on a 17n+5 grid (124 ≈ 5 s). */
export const minimaxFrameCount = (durationSeconds) => {
  const raw = Math.max(5, Math.round(durationSeconds * FPS))
  return raw + ((5 - (raw % 17)) % 17)
}

/**
 * Everything the worker would inject for a row, so a workflow binding can pick any of it.
 * @returns {object} data keys named like ai-workers-service's buildWorkflow output
 */
export const computeDims = ({ quality, aspect, duration, hasImage }) => {
  const tier = PRO_ASPECT_RATIOS[quality] || PRO_ASPECT_RATIOS[720]
  const ar = tier[aspect] ? aspect : '16:9'
  const row = tier[ar]
  const shorter = PRO_QUALITY_BASED_SIZE[quality] || PRO_QUALITY_BASED_SIZE[720]
  return {
    fps: FPS,
    duration,
    frameCount: Math.round(duration * FPS) + 1,
    adjustedFrameCount: Math.round(duration * FPS),
    minimaxFrameCount: minimaxFrameCount(duration),
    quality,
    aspectRatio: ar,
    // image modes: the worker sends only the shorter edge as `width`; the graph keeps the image AR
    width: hasImage ? shorter : row.width,
    height: hasImage ? Math.round(shorter * (row.height / row.width)) : row.height,
    cropWidth: row.cropWidth,
    cropHeight: row.cropHeight,
    upscaleFactor: row.multiplier
  }
}

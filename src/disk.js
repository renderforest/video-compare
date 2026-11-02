import fs from 'node:fs/promises'
import config from './config.js'

/** Free space (GiB) on the filesystem holding `dir`. */
export const freeDiskGb = async (dir = config.DATA_DIR) => {
  const s = await fs.statfs(dir)
  return (s.bavail * s.bsize) / 1024 ** 3
}

/**
 * Null when there is enough room, otherwise a human-readable reason.
 * The threshold covers a burst of downloads plus ComfyUI's own output copy.
 */
export const lowDiskReason = async () => {
  const free = await freeDiskGb()
  return free < config.MIN_FREE_DISK_GB
    ? `low disk space: ${free.toFixed(1)} GB free on ${config.DATA_DIR}, need ${config.MIN_FREE_DISK_GB} GB`
    : null
}

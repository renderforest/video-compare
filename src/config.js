import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const toInt = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const PORT = toInt(process.env.PORT, 3001)
const HOST = process.env.HOST || '0.0.0.0'

export default {
  ROOT,
  COMFY_URL: (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, ''),
  PORT,
  HOST,
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, ''),
  JOB_TIMEOUT_MS: toInt(process.env.JOB_TIMEOUT_MS, 30 * 60 * 1000),
  POLL_INTERVAL_MS: toInt(process.env.POLL_INTERVAL_MS, 3000),
  DATA_DIR: path.join(ROOT, 'data'),
  DB_PATH: path.join(ROOT, 'data', 'eval.sqlite'),
  OUTPUTS_DIR: path.join(ROOT, 'data', 'outputs'),
  INPUTS_DIR: path.join(ROOT, 'data', 'inputs'),
  PROD_DIR: path.join(ROOT, 'data', 'prod'),
  CSV_DIR: path.join(ROOT, 'data', 'csv'),
  WORKFLOWS_DIR: path.join(ROOT, 'workflows'),
  // generation pauses (and refuses to start) when the data disk has less free space than this
  MIN_FREE_DISK_GB: Number(process.env.MIN_FREE_DISK_GB) >= 0 ? Number(process.env.MIN_FREE_DISK_GB) : 30,
  // ComfyUI's output folder on the same machine: our clips (prefix vc_) are removed there once downloaded.
  // Empty = leave ComfyUI's copies alone.
  COMFY_OUTPUT_DIR: process.env.COMFY_OUTPUT_DIR || ''
}

import crypto from 'node:crypto'
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import WebSocket from 'ws'

const REQUEST_TIMEOUT_MS = 30000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|gif|webp)$/i

/**
 * fetch with a per-request timeout and retries on network throws or 5xx —
 * one blip of the GPU box must not kill a 15-minute generation.
 */
export const fetchRetry = async (url, options = {}, { attempts = 4, action = 'request', timeoutMs = REQUEST_TIMEOUT_MS } = {}) => {
  let lastError
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
      if (response.status >= 500) {
        lastError = new Error(`ComfyUI ${action} ${response.status}`)
        await sleep(1000 * (i + 1))
        continue
      }
      return response
    } catch (error) {
      lastError = error
      await sleep(1000 * (i + 1))
    }
  }
  throw new Error(`ComfyUI ${action} failed after ${attempts} attempts: ${lastError?.message || lastError}`)
}

const fail = async (response, action) => {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 500)
  } catch {
    detail = ''
  }
  throw new Error(`ComfyUI ${action} failed (${response.status}): ${detail}`)
}

export class ComfyClient {
  constructor({ baseUrl, timeoutMs = 30 * 60 * 1000, pollIntervalMs = 3000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/ws`
    this.timeoutMs = timeoutMs
    this.pollIntervalMs = pollIntervalMs
    this.clientId = crypto.randomUUID()
    this.ws = null
    this.listeners = new Set()
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.wsUrl}?clientId=${this.clientId}`)
      const timer = setTimeout(() => reject(new Error('websocket open timeout')), 10000)
      ws.on('open', () => {
        clearTimeout(timer)
        this.ws = ws
        resolve()
      })
      ws.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      ws.on('message', (raw) => {
        let msg
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return // binary preview frames
        }
        for (const listener of this.listeners) listener(msg)
      })
      ws.on('close', () => {
        this.ws = null
      })
    })
  }

  close() {
    if (this.ws) this.ws.close()
    this.ws = null
  }

  async ping() {
    try {
      const response = await fetch(`${this.baseUrl}/system_stats`, { signal: AbortSignal.timeout(6000) })
      return response.ok
    } catch {
      return false
    }
  }

  async getObjectInfo({ force = false } = {}) {
    if (!this._objectInfo || force) {
      const response = await fetchRetry(`${this.baseUrl}/object_info`, {}, { action: 'object_info', timeoutMs: 60000 })
      if (!response.ok) await fail(response, 'object_info')
      this._objectInfo = await response.json()
    }
    return this._objectInfo
  }

  /** Uploads any file into ComfyUI's input dir (the endpoint field is "image" but stores audio too). */
  async uploadFile({ filePath, filename, contentType = 'application/octet-stream' }) {
    const form = new FormData()
    form.append('image', new Blob([fs.readFileSync(filePath)], { type: contentType }), filename)
    form.append('overwrite', 'true')
    const response = await fetchRetry(`${this.baseUrl}/upload/image`, { method: 'POST', body: form }, { action: 'upload', timeoutMs: 120000 })
    if (!response.ok) await fail(response, 'upload')
    const data = await response.json()
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name
  }

  /** @returns {Promise<string>} the prompt_id (client-generated, like the production worker) */
  async queuePrompt(graph) {
    const promptId = crypto.randomUUID()
    const body = JSON.stringify({ prompt: graph, client_id: this.clientId, prompt_id: promptId })
    const response = await fetchRetry(
      `${this.baseUrl}/prompt`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      { action: 'prompt' }
    )
    if (!response.ok) await fail(response, 'prompt')
    const data = await response.json()
    if (data.error) throw new Error(`ComfyUI rejected the prompt: ${JSON.stringify(data.error)} ${JSON.stringify(data.node_errors || {}).slice(0, 800)}`)
    return data.prompt_id || promptId
  }

  async getHistory(promptId) {
    const response = await fetchRetry(`${this.baseUrl}/history/${promptId}`, {}, { attempts: 2, action: 'history' })
    if (!response.ok) await fail(response, 'history')
    return (await response.json())[promptId] || null
  }

  // Is the prompt still known to the server? null = could not ask.
  async isQueued(promptId) {
    try {
      const response = await fetchRetry(`${this.baseUrl}/queue`, {}, { attempts: 2, action: 'queue' })
      if (!response.ok) return null
      const q = await response.json()
      return [...(q.queue_running || []), ...(q.queue_pending || [])].map((e) => e[1]).includes(promptId)
    } catch {
      return null
    }
  }

  async interrupt() {
    try {
      await fetch(`${this.baseUrl}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(6000) })
    } catch {
      // unreachable — the loop stops before the next instance anyway
    }
  }

  /**
   * Resolves when the prompt finishes. Websocket events are the fast path; /history polling
   * the fallback; a prompt unknown to both history and queue for 3 checks means ComfyUI
   * restarted (OOM) and dropped it — fail fast instead of waiting for the timeout.
   */
  waitForCompletion(promptId, { onProgress = () => {} } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false
      let vanished = 0
      const finish = (fn, arg) => {
        if (settled) return
        settled = true
        this.listeners.delete(onMessage)
        clearInterval(pollTimer)
        clearTimeout(killTimer)
        fn(arg)
      }
      const onMessage = (msg) => {
        const data = msg.data || {}
        if (msg.type === 'progress' && data.prompt_id === promptId) onProgress({ value: data.value, max: data.max, node: data.node })
        if (data.prompt_id !== promptId) return
        if (msg.type === 'execution_interrupted') finish(reject, new Error('Generation interrupted'))
        else if (msg.type === 'execution_error') {
          finish(reject, new Error(`ComfyUI execution error in ${data.node_type || data.node_id}: ${data.exception_message || JSON.stringify(data).slice(0, 500)}`))
        } else if (msg.type === 'execution_success' || (msg.type === 'executing' && data.node === null)) finish(resolve)
      }
      this.listeners.add(onMessage)

      const pollTimer = setInterval(async () => {
        let history = null
        try {
          history = await this.getHistory(promptId)
        } catch {
          return // briefly unreachable; keep polling
        }
        if (history) {
          const status = history.status || {}
          if (status.status_str === 'error') {
            const messages = (status.messages || []).filter((m) => m[0] === 'execution_error').map((m) => m[1]?.exception_message).filter(Boolean)
            finish(reject, new Error(`ComfyUI execution error: ${messages.join('; ') || 'see ComfyUI log'}`))
          } else if (status.completed || Object.keys(history.outputs || {}).length) finish(resolve)
          return
        }
        const queued = await this.isQueued(promptId)
        vanished = queued === false ? vanished + 1 : 0
        if (vanished >= 3) finish(reject, new Error('prompt disappeared from ComfyUI (cancelled from the queue by someone else, or the server restarted)'))
      }, this.pollIntervalMs)

      const killTimer = setTimeout(
        () => finish(reject, new Error(`Timed out after ${Math.round(this.timeoutMs / 60000)} min waiting for ${promptId}`)),
        this.timeoutMs
      )
    })
  }

  /**
   * Finds the saved video among the prompt's outputs. PixaromaSaveVideo lists it under
   * `images` with format video/mp4 (+ a `_pixaroma_status` block), VHS_VideoCombine under
   * `gifs`, core SaveVideo under `videos`/`images`.
   */
  async findVideoOutput(promptId) {
    const history = await this.getHistory(promptId)
    if (!history) throw new Error(`No history for prompt ${promptId}`)
    const candidates = []
    for (const [nodeId, output] of Object.entries(history.outputs || {})) {
      for (const list of ['videos', 'gifs', 'images', 'pixaroma_save_video']) {
        for (const item of output[list] || []) {
          const isVideo = /^video\//.test(item.format || '') || VIDEO_EXT.test(item.filename || '')
          if (isVideo && item.filename) candidates.push({ nodeId, list, ...item })
        }
      }
    }
    const pick = candidates.find((c) => c.type === 'output') || candidates[0]
    if (!pick) throw new Error(`Prompt ${promptId} finished but produced no video (outputs: ${Object.keys(history.outputs || {}).join(',') || 'none'})`)
    return pick
  }

  /** Streams an output file to disk (never buffers a video in memory). */
  async downloadToFile({ filename, subfolder = '', type = 'output', destPath }) {
    const params = new URLSearchParams({ filename, subfolder, type })
    const response = await fetchRetry(`${this.baseUrl}/view?${params}`, {}, { action: 'view', timeoutMs: 10 * 60 * 1000 })
    if (!response.ok) await fail(response, 'view')
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destPath))
    return fs.statSync(destPath).size
  }
}

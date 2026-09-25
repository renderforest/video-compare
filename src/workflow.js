import crypto from 'node:crypto'

/**
 * A workflow is a raw ComfyUI "Save (API Format)" export: { "<nodeId>": { class_type, inputs, _meta } }.
 * The tool never needs placeholders: it detects where each value goes ("bindings") from node classes
 * and titles, stores them with the workflow, and lets the user edit them. %%PLACEHOLDER%% tokens are
 * still honoured for people who prefer explicit control.
 *
 * Binding shape: { key, node, input, via?: 'value' | 'combo' | 'json', field?, role?, kind? }
 *   key    what the runner fills: prompt | seed | duration | frames | aspect | megapixels | width | height |
 *          crop_width | crop_height | upscale_factor | fps | watermark | output_prefix |
 *          image_<n> (file slot) | image_url_<n> (URL slot) | audio_<n> | audio_url_<n>
 *   via    'value' sets inputs[input]; 'combo' picks the option that matches the aspect ratio;
 *          'json' updates `field` inside a JSON-string input (Pixaroma state nodes)
 *   role   for image slots: 'firstFrame' | 'lastFrame' | 'reference' (defaults: slot 1 first frame)
 */

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex')

export const onlyNodes = (template) =>
  Object.fromEntries(Object.entries(template).filter(([, v]) => v && typeof v === 'object' && v.class_type))

const title = (node) => String(node?._meta?.title || '')
const isLink = (v) => Array.isArray(v) && v.length === 2
const byId = (a, b) => Number(a) - Number(b)

const IMAGE_FILE_CLASSES = /^LoadImage$|^LoadImageMask$|LoadImageOutput/i
const IMAGE_URL_CLASSES = /LoadImageFromHttpURL|LoadImageFromUrl|LoadImageByUrl|LoadImageFromURL/i
const AUDIO_CLASSES = /VHS_LoadAudio|^LoadAudio$/i
const VIDEO_CONDITIONING = /ToVideo|LatentVideo|EmptyHunyuan|EmptyLTX|EmptyMochi|WanImageToVideo|MiniMax/i
const OUTPUT_CLASSES = /PixaromaSaveVideo|VHS_VideoCombine|^SaveVideo$|SaveAnimatedWEBP|SaveWEBM|CreateVideo/i

/** Detects bindings for a raw API export. Pure; safe to call on upload and again later. */
export const detectBindings = (graph) => {
  const bindings = []
  const notes = []
  const push = (b) => bindings.push({ via: 'value', ...b })
  const entries = Object.entries(graph).sort(([a], [b]) => byId(a, b))

  // seeds
  for (const [id, node] of entries) {
    for (const input of ['seed', 'noise_seed']) {
      if (typeof node.inputs?.[input] === 'number' || /^\d+$/.test(String(node.inputs?.[input] ?? 'x'))) {
        push({ key: 'seed', node: id, input })
      }
    }
    if (typeof node.inputs?.SeedState === 'string') push({ key: 'seed', node: id, input: 'SeedState', via: 'json', field: 'seed' })
  }

  // prompt: the string node feeding a `prompt` / `positive` input (negative branches excluded)
  const negativeSources = new Set()
  const promptSources = new Set()
  for (const [, node] of entries) {
    for (const [name, value] of Object.entries(node.inputs || {})) {
      if (!isLink(value)) continue
      if (/negative/i.test(name)) negativeSources.add(String(value[0]))
      if (/^(prompt|positive|text)$/i.test(name)) promptSources.add(String(value[0]))
    }
  }
  const stringInputOf = (node) =>
    ['text', 'value', 'string', 'prompt'].find((f) => typeof node.inputs?.[f] === 'string' && !isLink(node.inputs[f]))
  const promptNodes = [...promptSources].filter((id) => !negativeSources.has(id) && graph[id] && stringInputOf(graph[id]))
  if (!promptNodes.length) {
    const titled = entries.find(([, n]) => /prompt/i.test(title(n)) && !/negative/i.test(title(n)) && stringInputOf(n))
    if (titled) promptNodes.push(titled[0])
  }
  for (const id of new Set(promptNodes)) push({ key: 'prompt', node: id, input: stringInputOf(graph[id]) })
  if (!promptNodes.length) notes.push('No prompt node found — add a %%PROMPT%% placeholder or edit bindings.')

  // duration (seconds) or a literal frame count on the video conditioning node
  const durationNode = entries.find(
    ([, n]) => /^Primitive(Float|Int)$/i.test(n.class_type) && /duration|seconds/i.test(title(n)) && !isLink(n.inputs?.value)
  )
  if (durationNode) push({ key: 'duration', node: durationNode[0], input: 'value' })
  for (const [id, node] of entries) {
    if (!VIDEO_CONDITIONING.test(node.class_type)) continue
    for (const input of ['length', 'num_frames', 'frames', 'frame_count', 'video_length']) {
      if (typeof node.inputs?.[input] === 'number') {
        push({ key: 'frames', node: id, input, kind: /MiniMax/i.test(node.class_type) ? 'minimax' : 'plain' })
      }
    }
    for (const input of ['width', 'height']) {
      if (typeof node.inputs?.[input] === 'number') push({ key: input, node: id, input })
    }
  }
  for (const [id, node] of entries) {
    if (/^Primitive(Int|Float)$/i.test(node.class_type) && !isLink(node.inputs?.value)) {
      if (/^width$/i.test(title(node))) push({ key: 'width', node: id, input: 'value' })
      if (/^height$/i.test(title(node))) push({ key: 'height', node: id, input: 'value' })
      if (/frame.?rate|^fps$/i.test(title(node))) push({ key: 'fps', node: id, input: 'value' })
      if (/upscale|multiplier/i.test(title(node)) && !/resolution/i.test(title(node))) {
        push({ key: 'upscale_factor', node: id, input: 'value' })
      }
    }
    if (node.class_type === 'ResolutionSelector') {
      push({ key: 'aspect', node: id, input: 'aspect_ratio', via: 'combo' })
      push({ key: 'megapixels', node: id, input: 'megapixels' })
    }
    if (/CenterCropImages/i.test(node.class_type)) {
      if (typeof node.inputs?.width === 'number') push({ key: 'crop_width', node: id, input: 'width' })
      if (typeof node.inputs?.height === 'number') push({ key: 'crop_height', node: id, input: 'height' })
    }
    if (/ComfySwitchNode/i.test(node.class_type) && /watermark/i.test(title(node))) {
      const boolInput = Object.keys(node.inputs || {}).find((k) => typeof node.inputs[k] === 'boolean')
      if (boolInput) push({ key: 'watermark', node: id, input: boolInput })
    }
    if (typeof node.inputs?.filename_prefix === 'string') push({ key: 'output_prefix', node: id, input: 'filename_prefix' })
    if (typeof node.inputs?.SaveVideoState === 'string') {
      push({ key: 'output_prefix', node: id, input: 'SaveVideoState', via: 'json', field: 'pattern' })
    }
  }

  // media slots, in node-id order. Role comes from what the loader feeds
  // (first_frame / last_frame / ref_images.*), then from its title, then from its position.
  let imageSlot = 0
  let audioSlot = 0
  const consumers = new Map() // loader id → input names it is wired into
  for (const [, node] of entries) {
    for (const [name, value] of Object.entries(node.inputs || {})) {
      if (!isLink(value)) continue
      const src = String(value[0])
      if (!consumers.has(src)) consumers.set(src, new Set())
      consumers.get(src).add(name)
    }
  }
  const feeds = (id) => [...(consumers.get(id) || [])].join(' ')
  const roleFor = (node, id, index) => {
    const fed = feeds(id)
    if (/last_frame|end_image|end_frame/i.test(fed)) return 'lastFrame'
    if (/first_frame|start_image|start_frame|^image$/i.test(fed)) return 'firstFrame'
    if (/ref_image/i.test(fed)) return index === 0 ? 'firstFrame' : 'reference'
    if (/last/i.test(title(node))) return 'lastFrame'
    if (/first|start/i.test(title(node))) return 'firstFrame'
    if (/ref/i.test(title(node))) return 'reference'
    return index === 0 ? 'firstFrame' : 'reference'
  }
  for (const [id, node] of entries) {
    if (IMAGE_FILE_CLASSES.test(node.class_type) && typeof node.inputs?.image === 'string') {
      imageSlot += 1
      push({ key: `image_${imageSlot}`, node: id, input: 'image', role: roleFor(node, id, imageSlot - 1), ...(/ref_image/i.test(feeds(id)) && { kind: 'reference' }) })
    } else if (IMAGE_URL_CLASSES.test(node.class_type)) {
      const input = ['url', 'image_url', 'image'].find((f) => typeof node.inputs?.[f] === 'string')
      if (!input) continue
      imageSlot += 1
      push({ key: `image_url_${imageSlot}`, node: id, input, role: roleFor(node, id, imageSlot - 1), ...(/ref_image/i.test(feeds(id)) && { kind: 'reference' }) })
    } else if (AUDIO_CLASSES.test(node.class_type)) {
      const input = ['audio_file', 'audio', 'url'].find((f) => typeof node.inputs?.[f] === 'string')
      if (!input) continue
      audioSlot += 1
      push({ key: `audio_url_${audioSlot}`, node: id, input })
    }
  }

  if (!entries.some(([, n]) => OUTPUT_CLASSES.test(n.class_type))) {
    notes.push('No video output node found (PixaromaSaveVideo / VHS_VideoCombine / SaveVideo).')
  }
  return { bindings, notes }
}

/** What a graph can replay, derived from its bindings. */
export const capabilities = (bindings) => {
  const images = bindings.filter((b) => /^image(_url)?_\d+$/.test(b.key))
  const audios = bindings.filter((b) => /^audio(_url)?_\d+$/.test(b.key))
  const hasPrompt = bindings.some((b) => b.key === 'prompt')
  const hasLastFrame = images.some((b) => b.role === 'lastFrame')
  // reference slots feed ref_images.*; a graph with only first/last frame inputs cannot take references
  const referenceSlots = images.filter((b) => b.kind === 'reference').length
  return {
    hasPrompt,
    hasDuration: bindings.some((b) => b.key === 'duration' || b.key === 'frames'),
    hasAspect: bindings.some((b) => ['aspect', 'width', 'height'].includes(b.key)),
    hasQuality: bindings.some((b) => ['megapixels', 'width', 'crop_width'].includes(b.key)),
    imageSlots: images.length,
    referenceSlots,
    audioSlots: audios.length,
    hasLastFrame,
    modes: {
      t2v: hasPrompt,
      i2v: images.length >= 1,
      flf: images.length >= 2 && hasLastFrame,
      ia2v: images.length >= 1 && audios.length >= 1,
      refi2v: referenceSlots >= 1
    }
  }
}

export const MODES = ['t2v', 'i2v', 'flf', 'ia2v', 'refi2v']

/** Why an instance cannot run on this workflow, or null when it can. */
export const unsupportedReason = ({ caps, instance }) => {
  const refImages = JSON.parse(instance.ref_images_json || '[]')
  const refAudios = JSON.parse(instance.ref_audios_json || '[]')
  if (!caps.modes[instance.mode]) return `workflow has no inputs for mode ${instance.mode}`
  if (instance.mode === 'refi2v') {
    if (refImages.length > caps.referenceSlots) return `needs ${refImages.length} reference image slots, workflow has ${caps.referenceSlots}`
    if (refAudios.length > caps.audioSlots) return `needs ${refAudios.length} audio slots, workflow has ${caps.audioSlots}`
  }
  return null
}

/**
 * Which media goes into which slot for this instance.
 * @returns {{ images: Array<{ slotIndex, url }>, audios: Array<{ slotIndex, url }> }}
 */
export const assignMedia = ({ bindings, instance }) => {
  const imageSlots = bindings.filter((b) => /^image(_url)?_\d+$/.test(b.key))
  const audioSlots = bindings.filter((b) => /^audio(_url)?_\d+$/.test(b.key))
  const images = []
  const audios = []
  const firstSlot = imageSlots.find((b) => b.role === 'firstFrame') || imageSlots[0]
  const lastSlot = imageSlots.find((b) => b.role === 'lastFrame') || imageSlots[1]
  const put = (list, slot, url) => {
    if (slot && url) list.push({ binding: slot, url })
  }
  switch (instance.mode) {
    case 'i2v':
      put(images, firstSlot, instance.first_frame_url)
      break
    case 'flf':
      put(images, firstSlot, instance.first_frame_url)
      put(images, lastSlot, instance.last_frame_url)
      break
    case 'ia2v':
      put(images, firstSlot, instance.first_frame_url)
      put(audios, audioSlots[0], instance.audio_url)
      break
    case 'refi2v': {
      const refImages = JSON.parse(instance.ref_images_json || '[]')
      const refAudios = JSON.parse(instance.ref_audios_json || '[]')
      const referenceSlots = imageSlots.filter((b) => b.kind === 'reference')
      refImages.forEach((url, i) => put(images, referenceSlots[i] || imageSlots[i], url))
      refAudios.forEach((url, i) => put(audios, audioSlots[i], url))
      break
    }
    default:
      break
  }
  return { images, audios }
}

const setJsonField = (raw, field, value) => {
  let state
  try {
    state = JSON.parse(raw)
  } catch {
    state = {}
  }
  state[field] = value
  return JSON.stringify(state)
}

const pickComboOption = ({ objectInfo, node, input, wanted }) => {
  const spec = objectInfo?.[node.class_type]?.input
  const def = spec?.required?.[input] || spec?.optional?.[input]
  const options = Array.isArray(def?.[0]) ? def[0] : def?.[1]?.options
  if (!Array.isArray(options)) return null
  return options.find((o) => String(o).startsWith(wanted)) || options.find((o) => String(o).includes(wanted)) || null
}

/**
 * Applies values to a template through its bindings (and %%PLACEHOLDERS%% if present).
 * `values` keys match binding keys; media slot keys carry the resolved filename/URL or ''.
 */
export const buildPrompt = ({ template, bindings, values, objectInfo }) => {
  let graph = structuredClone(onlyNodes(template))
  for (const b of bindings) {
    if (!(b.key in values)) continue
    const node = graph[b.node]
    if (!node) continue
    const value = values[b.key]
    if (b.via === 'json') {
      node.inputs[b.input] = setJsonField(node.inputs[b.input], b.field, value)
    } else if (b.via === 'combo') {
      const option = pickComboOption({ objectInfo, node, input: b.input, wanted: String(value) })
      if (option) node.inputs[b.input] = option
    } else {
      const current = node.inputs[b.input]
      node.inputs[b.input] = typeof current === 'number' && value !== '' && value != null ? Number(value) : value
    }
  }
  if (JSON.stringify(template).includes('%%')) graph = instantiatePlaceholders({ template: graph, values })
  return graph
}

/** Replaces %%KEY%% tokens (upper-case binding keys). Exact-match strings keep the value's type. */
export const instantiatePlaceholders = ({ template, values }) => {
  const upper = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toUpperCase(), v]))
  const walk = (v) => {
    if (typeof v === 'string') {
      const exact = v.match(/^%%([A-Z0-9_]+)%%$/)
      if (exact && exact[1] in upper) return upper[exact[1]]
      return v.replace(/%%([A-Z0-9_]+)%%/g, (m, key) => (key in upper ? String(upper[key] ?? '') : m))
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(template)
}

/**
 * Removes media loader nodes whose slot stayed empty (fewer inputs than the graph has slots),
 * then cascades: links to removed nodes are dropped when optional, or the dependent node is
 * removed too when the input is required. Mirrors ai-workers-service pruneUnusedReferenceInputs.
 */
export const pruneEmptySlots = ({ graph, bindings, objectInfo }) => {
  const removed = new Set()
  for (const b of bindings) {
    if (!/^(image|audio)(_url)?_\d+$/.test(b.key)) continue
    const node = graph[b.node]
    if (node && node.inputs[b.input] === '') removed.add(b.node)
  }
  if (!removed.size) return graph
  let changed = true
  while (changed) {
    changed = false
    for (const [id, node] of Object.entries(graph)) {
      if (removed.has(id)) continue
      for (const [name, value] of Object.entries(node.inputs || {})) {
        if (!isLink(value) || !removed.has(String(value[0]))) continue
        const spec = objectInfo?.[node.class_type]?.input || {}
        if (spec.required && name in spec.required) {
          removed.add(id)
          changed = true
          break
        }
        delete node.inputs[name]
      }
    }
  }
  return Object.fromEntries(Object.entries(graph).filter(([id]) => !removed.has(id)))
}

/** Node classes the graph uses that the ComfyUI instance does not know. */
export const missingClasses = ({ graph, objectInfo }) =>
  [...new Set(Object.values(graph).map((n) => n.class_type))].filter((c) => !objectInfo[c])

/** Parses + validates an uploaded workflow file. Throws with a user-facing message. */
export const parseWorkflowUpload = (raw) => {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Not valid JSON')
  }
  if (parsed && parsed.prompt && typeof parsed.prompt === 'object' && !parsed.class_type) parsed = parsed.prompt
  if (Array.isArray(parsed?.nodes) && Array.isArray(parsed?.links)) {
    throw new Error('This is a UI-format export. In ComfyUI enable Dev mode and use "Save (API Format)".')
  }
  const graph = onlyNodes(parsed)
  if (!Object.keys(graph).length) throw new Error('No ComfyUI nodes found — export the workflow in API format')
  const { bindings, notes } = detectBindings(graph)
  return { graph, bindings, notes }
}

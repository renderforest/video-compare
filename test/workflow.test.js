import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeRecord, deriveMode } from '../src/csv.js'
import { detectBindings, capabilities, assignMedia, buildPrompt, pruneEmptySlots, unsupportedReason } from '../src/workflow.js'
import { computeDims, minimaxFrameCount, classifyAspect } from '../src/dims.js'

const graph = JSON.parse(fs.readFileSync(new URL('../workflows/h3_best_api.json', import.meta.url), 'utf8'))

test('mode derivation mirrors the worker precedence', () => {
  assert.equal(deriveMode({ refImages: ['a'], refAudios: [], audioUrl: 'x', lastFrameUrl: 'y', firstFrameUrl: 'z' }), 'refi2v')
  assert.equal(deriveMode({ refImages: [], refAudios: [], audioUrl: 'x', lastFrameUrl: 'y', firstFrameUrl: 'z' }), 'ia2v')
  assert.equal(deriveMode({ refImages: [], refAudios: [], audioUrl: null, lastFrameUrl: 'y', firstFrameUrl: 'z' }), 'flf')
  assert.equal(deriveMode({ refImages: [], refAudios: [], audioUrl: null, lastFrameUrl: null, firstFrameUrl: 'z' }), 'i2v')
  assert.equal(deriveMode({ refImages: [], refAudios: [], audioUrl: null, lastFrameUrl: null, firstFrameUrl: null }), 't2v')
})

test('normalizeRecord infers aspect from the production output when the row has none', () => {
  const { row } = normalizeRecord({ videoUrl: 'https://x/v.mp4', quality: '720', videoDurationSeconds: '5', prompt: 'p', firstFrameUrl: 'https://x/i.jpg', width: '720', height: '1280', styleName: 'Anime', videoTypeName: 'Anime' })
  assert.equal(row.mode, 'i2v')
  assert.equal(row.aspect, '9:16')
  assert.equal(row.aspect_source, 'output')
  assert.equal(row.duration_bucket, '4-6')
  assert.equal(row.scenario_key, 'i2v | 720 | 9:16 | 4-6 | Anime / Anime')
  assert.equal(normalizeRecord({ videoUrl: 'null', prompt: 'p' }).skip, 'no production video url')
})

test('dims follow the production worker tables', () => {
  assert.deepEqual(classifyAspect(854, 480), '16:9')
  assert.equal(minimaxFrameCount(5), 124)
  const t2v = computeDims({ quality: 720, aspect: '9:16', duration: 5, hasImage: false })
  assert.equal(t2v.width, 640)
  assert.equal(t2v.height, 1152)
  assert.equal(t2v.cropWidth, 720)
  assert.equal(t2v.upscaleFactor, 1.34)
  const i2v = computeDims({ quality: 480, aspect: '16:9', duration: 2, hasImage: true })
  assert.equal(i2v.width, 480)
  assert.equal(i2v.adjustedFrameCount, 48)
})

test('detects bindings of the h3 workflow', () => {
  const { bindings } = detectBindings(graph)
  const keys = Object.fromEntries(bindings.map((b) => [b.key, b]))
  assert.equal(keys.prompt.node, '12')
  assert.equal(keys.seed.node, '8')
  assert.equal(keys.duration.node, '13')
  assert.equal(keys.aspect.via, 'combo')
  assert.equal(keys.megapixels.node, '15')
  assert.equal(keys.image_1.node, '10')
  const caps = capabilities(bindings)
  assert.deepEqual(caps.modes, { t2v: true, i2v: true, flf: false, ia2v: false, refi2v: true })
  assert.equal(unsupportedReason({ caps, instance: { mode: 'ia2v', ref_images_json: '[]', ref_audios_json: '[]' } }), 'workflow has no inputs for mode ia2v')
  assert.match(unsupportedReason({ caps, instance: { mode: 'refi2v', ref_images_json: '["a","b"]', ref_audios_json: '[]' } }), /needs 2 reference image slots/)
})

test('builds an i2v graph and prunes the image loader for t2v', () => {
  const { bindings } = detectBindings(graph)
  const objectInfo = {
    ResolutionSelector: { input: { required: { aspect_ratio: [['1:1 (Square)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)']] } } },
    MiniMaxH3ReferenceToVideo: { input: { required: { prompt: ['STRING'] } } }
  }
  const instance = { mode: 'i2v', first_frame_url: 'https://x/a.jpg', ref_images_json: '[]', ref_audios_json: '[]' }
  const { images } = assignMedia({ bindings, instance })
  assert.equal(images[0].binding.key, 'image_1')
  const values = { prompt: 'hello', seed: 7, duration: 3, aspect: '9:16', megapixels: 0.15, image_1: 'a.jpg', output_prefix: 'vc_1' }
  const built = buildPrompt({ template: graph, bindings, values, objectInfo })
  assert.equal(built['12'].inputs.text, 'hello')
  assert.equal(built['8'].inputs.noise_seed, 7)
  assert.equal(built['13'].inputs.value, 3)
  assert.equal(built['15'].inputs.aspect_ratio, '9:16 (Portrait Widescreen)')
  assert.equal(built['15'].inputs.megapixels, 0.15)
  assert.equal(built['10'].inputs.image, 'a.jpg')
  assert.equal(JSON.parse(built['43'].inputs.SaveVideoState).pattern, 'vc_1')

  const t2v = pruneEmptySlots({ graph: buildPrompt({ template: graph, bindings, values: { ...values, image_1: '' }, objectInfo }), bindings, objectInfo })
  assert.equal(t2v['10'], undefined)
  assert.equal(t2v['18'].inputs['ref_images.ref_image_0'], undefined)
  assert.ok(t2v['18'].inputs.prompt)
})

test('first/last-frame graph: roles come from the inputs the loaders feed', () => {
  const flv = JSON.parse(fs.readFileSync(new URL('../workflows/H3_FLV.json', import.meta.url), 'utf8'))
  const { bindings } = detectBindings(flv)
  const images = bindings.filter((b) => b.key.startsWith('image_'))
  assert.deepEqual(images.map((b) => [b.node, b.role]), [['10', 'firstFrame'], ['264', 'lastFrame']])
  const caps = capabilities(bindings)
  assert.deepEqual(caps.modes, { t2v: true, i2v: true, flf: true, ia2v: false, refi2v: false })
  const instance = { mode: 'flf', first_frame_url: 'https://x/a.jpg', last_frame_url: 'https://x/b.jpg', ref_images_json: '[]', ref_audios_json: '[]' }
  const { images: assigned } = assignMedia({ bindings, instance })
  assert.deepEqual(assigned.map((a) => [a.binding.key, a.url]), [['image_1', 'https://x/a.jpg'], ['image_2', 'https://x/b.jpg']])
})

test('reference graph: refi2v counts only reference-fed slots', () => {
  const { bindings } = detectBindings(graph)
  const caps = capabilities(bindings)
  assert.equal(caps.referenceSlots, 1)
  assert.equal(unsupportedReason({ caps, instance: { mode: 'refi2v', ref_images_json: '["a"]', ref_audios_json: '[]' } }), null)
})

// Shows what the tool detected in a workflow file, without touching the DB or ComfyUI.
import fs from 'node:fs'
import { parseWorkflowUpload, capabilities } from '../workflow.js'

const file = process.argv[2]
if (!file) {
  console.error('Usage: npm run inspect -- <workflow-api.json>')
  process.exit(1)
}
const { graph, bindings, notes } = parseWorkflowUpload(fs.readFileSync(file, 'utf8'))
console.log(`${Object.keys(graph).length} nodes`)
console.table(bindings.map((b) => ({ key: b.key, node: b.node, class: graph[b.node].class_type, title: graph[b.node]._meta?.title || '', input: b.input, via: b.via, role: b.role || '' })))
console.log('capabilities:', JSON.stringify(capabilities(bindings)))
for (const note of notes) console.log('note:', note)

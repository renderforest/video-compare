import fs from 'node:fs'
import db from '../db.js'
import { exportInstancesCsv, exportSummaryCsv } from '../export.js'

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 ? args[i + 1] : def
}
const runId = Number(args.find((a) => !a.startsWith('--'))) || db.prepare('SELECT id FROM runs ORDER BY id DESC LIMIT 1').get()?.id
if (!runId) {
  console.error('No runs yet. Usage: npm run export -- [runId] [--out results.csv] [--summary summary.csv]')
  process.exit(1)
}
const out = flag('out', `video-compare-run-${runId}.csv`)
const summary = flag('summary', `video-compare-run-${runId}-summary.csv`)
fs.writeFileSync(out, exportInstancesCsv(runId))
fs.writeFileSync(summary, exportSummaryCsv(runId))
console.log(`wrote ${out} and ${summary}`)

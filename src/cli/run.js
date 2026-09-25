import db from '../db.js'
import { runPending } from '../runner.js'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 ? args[i + 1] : undefined
}
const runId = Number(args.find((a) => !a.startsWith('--'))) || db.prepare('SELECT id FROM runs ORDER BY id DESC LIMIT 1').get()?.id
if (!runId) {
  console.error('No runs yet. Usage: npm run run -- [runId] [--workflow <id>]')
  process.exit(1)
}
if (flag('workflow')) db.prepare('UPDATE runs SET workflow_id = ? WHERE id = ?').run(Number(flag('workflow')), runId)

const result = await runPending({
  runId,
  onProgress: (p) => {
    if (p.phase === 'prefetch') process.stdout.write(`\rprefetch ${p.done}/${p.total}`)
    else console.log(`\ninstance ${p.instanceId}: ${p.status}`)
  }
})
console.log(JSON.stringify(result))
process.exit(result.failed ? 2 : 0)

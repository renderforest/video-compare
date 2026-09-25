import path from 'node:path'
import { importCsv, coverage } from '../scenario.js'

const args = process.argv.slice(2)
const csvPath = args.find((a) => !a.startsWith('--'))
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 ? args[i + 1] : def
}
if (!csvPath) {
  console.error('Usage: npm run import -- <csv> [--name <name>] [--per-cell 5] [--seed 42]')
  process.exit(1)
}

const result = await importCsv({
  csvPath: path.resolve(csvPath),
  name: flag('name', path.basename(csvPath, path.extname(csvPath))),
  perCell: Number(flag('per-cell', 5)),
  seed: flag('seed') ? Number(flag('seed')) : undefined
})
console.log(`Run #${result.runId}: imported ${result.imported} rows, ${result.cells} scenario cells, sampled ${result.sampled}`)
if (Object.keys(result.skipped).length) console.log('skipped:', result.skipped)
console.table(coverage(result.runId).map((c) => ({ scenario: c.scenario_key, pool: c.pool, sampled: c.sampled })))

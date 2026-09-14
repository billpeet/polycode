const { spawnSync } = require('node:child_process')
const path = require('node:path')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), [path.join(__dirname, 'crash-smoke.cjs')], {
  env, windowsHide: true, stdio: 'inherit', timeout: 30000,
})
if (result.error) console.error(result.error)
process.exit(result.status ?? 1)

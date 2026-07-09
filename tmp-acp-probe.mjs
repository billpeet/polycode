import { spawn } from 'node:child_process'
import readline from 'node:readline'

const cwd = process.cwd()
const child = spawn('cursor-agent', ['acp'], { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
const rl = readline.createInterface({ input: child.stdout })
const pending = new Map()
let nextId = 1

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  // Auto-answer any server request so we don't block
  if (msg.method && msg.id !== undefined) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n')
    return
  }
  if (msg.id !== undefined && !msg.method) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
    else p.resolve(msg.result)
  }
})

child.stderr.on('data', (c) => process.stderr.write('[stderr] ' + c))

const dump = (title, v) => { console.log(`\n=== ${title} ===`); console.log(JSON.stringify(v, null, 2)) }

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { parameterizedModelPicker: true } },
    clientInfo: { name: 'polycode-probe', version: '0.0.0' },
  })
  dump('INITIALIZE._meta', init?._meta ?? null)
  dump('INITIALIZE.authMethods', init?.authMethods ?? null)
  await request('authenticate', { methodId: 'cursor_login' }).catch((e) => console.log('auth err:', e.message))
  const session = await request('session/new', { cwd, mcpServers: [] })
  dump('SESSION_NEW.keys', Object.keys(session ?? {}))
  dump('SESSION_NEW.models', session?.models ?? null)
  dump('SESSION_NEW.modes', session?.modes ?? null)
  const modelCfg = (session?.configOptions ?? []).filter(o => o.category === 'model' || o.id === 'model')
  dump('SESSION_NEW.configOptions[category=model]', modelCfg)
  dump('SESSION_NEW.configOptions.allCategories', (session?.configOptions ?? []).map(o => ({ id: o.id, category: o.category, type: o.type })))
} catch (e) {
  console.error('FATAL', e)
} finally {
  child.kill('SIGTERM')
  process.exit(0)
}

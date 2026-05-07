import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { homedir } from 'os'
import { execFileSync } from 'child_process'
import { Provider } from '../shared/types'

export interface DetectedSkill {
  id: string
  name: string
  description: string | null
  path: string
  scope: 'global' | 'project' | 'admin' | 'system'
  harness: Provider | 'gemini'
  invocation: string
}

function expandHome(p: string): string {
  return p.startsWith('~/') || p === '~' ? path.join(homedir(), p.slice(2)) : p
}

function readFrontmatter(file: string): Record<string, string> {
  try {
    const text = readFileSync(file, 'utf8')
    if (!text.startsWith('---')) return {}
    const end = text.indexOf('\n---', 3)
    if (end === -1) return {}
    const fm = text.slice(3, end).trim()
    const out: Record<string, string> = {}
    for (const line of fm.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
      if (!m) continue
      out[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim()
    }
    return out
  } catch {
    return {}
  }
}

function addSkill(out: DetectedSkill[], skillFile: string, harness: DetectedSkill['harness'], scope: DetectedSkill['scope']): void {
  const fm = readFrontmatter(skillFile)
  const dirName = path.basename(path.dirname(skillFile))
  const name = fm.name || dirName
  const description = fm.description || null
  const prefix = harness === 'codex' ? '$' : harness === 'pi' ? '/skill:' : '/'
  out.push({
    id: `${harness}:${scope}:${skillFile}`,
    name,
    description,
    path: skillFile,
    scope,
    harness,
    invocation: `${prefix}${name}`,
  })
}

function scanSkillDirs(out: DetectedSkill[], root: string, harness: DetectedSkill['harness'], scope: DetectedSkill['scope'], recursive = true): void {
  root = expandHome(root)
  if (!existsSync(root)) return
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { continue }
    if (entries.includes('SKILL.md')) addSkill(out, path.join(dir, 'SKILL.md'), harness, scope)
    if (!recursive && dir !== root) continue
    for (const entry of entries) {
      const full = path.join(dir, entry)
      try { if (statSync(full).isDirectory()) stack.push(full) } catch { /* ignore */ }
    }
  }
}

function gitRoot(cwd: string): string | null {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true }).trim()
  } catch {
    return null
  }
}

function ancestorsToRoot(cwd: string): string[] {
  const resolved = path.resolve(cwd)
  const root = gitRoot(resolved) ?? path.parse(resolved).root
  const dirs: string[] = []
  let cur = resolved
  while (true) {
    dirs.push(cur)
    if (cur === root || path.dirname(cur) === cur) break
    cur = path.dirname(cur)
  }
  return dirs
}

export function listDetectedSkills(provider: Provider, cwd?: string | null): DetectedSkill[] {
  const out: DetectedSkill[] = []
  const home = homedir()

  if (provider === 'claude-code') {
    scanSkillDirs(out, path.join(home, '.claude', 'skills'), 'claude-code', 'global')
    if (cwd) scanSkillDirs(out, path.join(cwd, '.claude', 'skills'), 'claude-code', 'project')
  } else if (provider === 'codex') {
    scanSkillDirs(out, path.join(home, '.agents', 'skills'), 'codex', 'global')
    scanSkillDirs(out, path.join(home, '.codex', 'skills'), 'codex', 'global')
    scanSkillDirs(out, '/etc/codex/skills', 'codex', 'admin')
    if (cwd) for (const dir of ancestorsToRoot(cwd)) scanSkillDirs(out, path.join(dir, '.agents', 'skills'), 'codex', 'project', false)
  } else if (provider === 'pi') {
    scanSkillDirs(out, path.join(home, '.pi', 'agent', 'skills'), 'pi', 'global')
    scanSkillDirs(out, path.join(home, '.agents', 'skills'), 'pi', 'global')
    if (cwd) {
      scanSkillDirs(out, path.join(cwd, '.pi', 'skills'), 'pi', 'project')
      for (const dir of ancestorsToRoot(cwd)) scanSkillDirs(out, path.join(dir, '.agents', 'skills'), 'pi', 'project', false)
    }
  }

  const seen = new Set<string>()
  return out.filter((s) => {
    const key = `${s.harness}:${s.scope}:${s.name}:${s.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => a.name.localeCompare(b.name))
}

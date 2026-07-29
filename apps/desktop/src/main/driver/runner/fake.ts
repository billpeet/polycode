import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import type { Runner, RunCommand, RunResult, RunScriptCommand, ScriptCommand, SpawnCommand } from './types'

export class FakeRunner implements Runner {
  readonly type: Runner['type']
  readonly spawned: SpawnCommand[] = []
  readonly runCommands: RunCommand[] = []
  readonly spawnedScripts: ScriptCommand[] = []
  readonly runScriptCommands: RunScriptCommand[] = []
  private readonly results: RunResult[] = []

  constructor(type: Runner['type'] = 'local') {
    this.type = type
  }

  queueResult(result: Partial<RunResult> = {}): void {
    this.results.push({
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
      timedOut: result.timedOut ?? false,
    })
  }

  spawn(command: SpawnCommand): ChildProcess {
    this.spawned.push(command)
    return new EventEmitter() as ChildProcess
  }

  async run(command: RunCommand): Promise<RunResult> {
    this.runCommands.push(command)
    return this.nextResult()
  }

  spawnScript(command: ScriptCommand): ChildProcess {
    this.spawnedScripts.push(command)
    return new EventEmitter() as ChildProcess
  }

  async runScript(command: RunScriptCommand): Promise<RunResult> {
    this.runScriptCommands.push(command)
    return this.nextResult()
  }

  private nextResult(): RunResult {
    return this.results.shift() ?? {
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }
  }
}

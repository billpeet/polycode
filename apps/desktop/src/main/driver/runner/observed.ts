import type { ChildProcess } from 'child_process'
import { SpanStatusCode } from '@opentelemetry/api'
import { recordDuration, withSpan } from '../../observability'
import type { Runner, RunCommand, RunResult, RunScriptCommand, ScriptCommand, SpawnCommand } from './types'

function executableName(binary: string): string {
  return binary.split(/[\\/]/).at(-1)?.slice(0, 80) || 'unknown'
}

/** Adds observability to collected commands while leaving streaming processes untouched. */
export class ObservedRunner implements Runner {
  readonly type: Runner['type']

  constructor(private readonly runner: Runner) {
    this.type = runner.type
  }

  spawn(command: SpawnCommand): ChildProcess {
    return this.runner.spawn(command)
  }

  spawnScript(command: ScriptCommand): ChildProcess {
    return this.runner.spawnScript(command)
  }

  run(command: RunCommand): Promise<RunResult> {
    return this.observe('command', executableName(command.binary), () => this.runner.run(command))
  }

  runScript(command: RunScriptCommand): Promise<RunResult> {
    return this.observe('script', 'shell', () => this.runner.runScript(command))
  }

  private async observe(
    kind: 'command' | 'script',
    executable: string,
    operation: () => Promise<RunResult>
  ): Promise<RunResult> {
    const attributes = {
      'runner.type': this.type,
      'runner.kind': kind,
      'process.executable.name': executable,
    }
    const metricAttributes = {
      'runner.type': this.type,
      'runner.kind': kind,
    }
    const startedAt = performance.now()

    return withSpan(`runner.${kind}`, attributes, async (span) => {
      try {
        const result = await operation()
        const outcome = result.timedOut ? 'timeout' : result.exitCode === 0 ? 'ok' : 'error'
        span?.setAttributes({
          'process.exit.code': result.exitCode ?? -1,
          'runner.outcome': outcome,
        })
        if (outcome !== 'ok') span?.setStatus({ code: SpanStatusCode.ERROR })
        return result
      } finally {
        recordDuration('polycode.runner.duration', performance.now() - startedAt, metricAttributes)
      }
    })
  }
}

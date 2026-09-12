import type { SshConfig, WslConfig } from '../shared/types'
import { createRunner } from './driver/runner'
import { runGit } from './git-runner'
import { parseAzureRemote, parseGitHubRemote, type AzureRepoContext, type GitHubRemote } from './forge-parsers'
import { forgeScope, repoContextCache } from './forge-cache'

export type ForgeRepoContext =
  | (GitHubRemote & { provider: 'github'; remoteName: string; remoteUrl: string })
  | (AzureRepoContext & { provider: 'azure' })

export function resolveForgeRepoContext(
  repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null,
): Promise<ForgeRepoContext | null> {
  return repoContextCache.read(forgeScope(repoPath, ssh, wsl), Infinity, async () => {
    const runner = createRunner({ ssh: ssh ?? undefined, wsl: wsl ?? undefined })
    const names = (await runGit(runner, repoPath, ['remote'])).split(/\r?\n/).map(name => name.trim()).filter(Boolean)
    const prioritized = names.includes('origin') ? ['origin', ...names.filter(name => name !== 'origin')] : names
    let probeError: unknown
    for (const remoteName of prioritized) {
      let remoteUrl: string
      try {
        remoteUrl = (await runGit(runner, repoPath, ['remote', 'get-url', remoteName])).trim()
      } catch (error) {
        probeError = error
        continue
      }
      const github = parseGitHubRemote(remoteUrl)
      if (github) return { ...github, provider: 'github', remoteName, remoteUrl }
      const azure = parseAzureRemote(remoteUrl)
      if (azure) return { ...azure, provider: 'azure', remoteName, remoteUrl }
    }
    // Don't permanently cache a negative result caused by a failed command.
    if (probeError) throw probeError
    return null
  })
}

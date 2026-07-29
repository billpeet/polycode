import type {
  PublishBranchInput,
  PublishBranchSuccess,
  PublishEffects,
  PublishStep,
  PullRequest,
} from '../shared/types'

export interface PublishRepositoryState {
  branch: string
  dirty: boolean
  ahead: number
  hasUpstream: boolean
}

export interface PublishBranchDependencies {
  inspect(repoPath: string): Promise<PublishRepositoryState>
  createBranch(repoPath: string, name: string, base: string): Promise<void>
  stageAll(repoPath: string): Promise<void>
  commit(repoPath: string, message: string): Promise<string>
  push(repoPath: string): Promise<void>
  createPullRequest(
    repoPath: string,
    payload: { target: string; title: string; description?: string },
  ): Promise<PullRequest>
}

export class PublishBranchError extends Error {
  constructor(
    readonly failedAt: PublishStep,
    readonly effects: PublishEffects,
    message: string,
  ) {
    super(message)
    this.name = 'PublishBranchError'
  }
}

export async function publishBranch(
  input: PublishBranchInput,
  dependencies: PublishBranchDependencies,
): Promise<PublishBranchSuccess> {
  const effects: PublishEffects = { pushed: false }
  let step: PublishStep = 'inspect'

  try {
    const state = await dependencies.inspect(input.repoPath)
    if (state.branch === input.targetBranch && !input.newBranchName) {
      throw new Error('A new branch name is required when publishing from the target branch')
    }
    if (state.dirty && !input.commitMessage) {
      throw new Error('A commit message is required when publishing uncommitted changes')
    }

    if (state.branch === input.targetBranch && input.newBranchName) {
      step = 'branch'
      await dependencies.createBranch(input.repoPath, input.newBranchName, state.branch)
      effects.branchCreated = input.newBranchName
    }

    if (state.dirty && input.commitMessage) {
      step = 'stage'
      await dependencies.stageAll(input.repoPath)
      step = 'commit'
      effects.commitCreated = await dependencies.commit(input.repoPath, input.commitMessage)
    }

    if (effects.branchCreated || effects.commitCreated || state.ahead > 0 || !state.hasUpstream) {
      step = 'push'
      await dependencies.push(input.repoPath)
      effects.pushed = true
    }

    step = 'pull-request'
    const pullRequest = await dependencies.createPullRequest(input.repoPath, {
      target: input.targetBranch,
      title: input.title,
      description: input.description,
    })
    return { ok: true, pullRequest, effects }
  } catch (error) {
    if (error instanceof PublishBranchError) throw error
    throw new PublishBranchError(
      step,
      effects,
      error instanceof Error ? error.message : String(error),
    )
  }
}

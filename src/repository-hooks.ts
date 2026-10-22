import { constants as osConstants } from 'node:os'

import type { Context } from './context.ts'
import { CliError } from './errors.ts'
import { messageOf } from './fsutil.ts'
import { runScript } from './process.ts'
import {
  findScript,
  loadScripts,
  noVersionFor,
  type RepositoryHook,
  scriptEnvironment,
} from './repository.ts'

/** How running a script of the repository ended. */
export type HookOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly signal?: NodeJS.Signals }

/**
 * Runs the script a setting of the repository names (`post_update`,
 * `post_init`), like `configfile scripts run`, with `CONFIGFILE_HOOK`, and
 * records it. A script only made for other systems is skipped, with a
 * message. Says why when it cannot run or fails, and returns it: the caller
 * says what was done already (see `failedHook`).
 */
export async function runRepositoryHook(
  hook: RepositoryHook,
  name: string,
  ctx: Context,
): Promise<HookOutcome> {
  const failed = (reason: string, signal?: NodeJS.Signals): HookOutcome => {
    ctx.output.error(`The ${hook} script of the repository, "${name}", ${reason}.`)
    return { ok: false, reason, ...(signal != null && { signal }) }
  }
  let scripts: Awaited<ReturnType<typeof loadScripts>>
  try {
    scripts = await loadScripts(ctx)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    return failed(`cannot be found: ${messageOf(error)}`)
  }
  const script = findScript(name, scripts)
  if (script === 'missing') {
    return failed('is not in scripts/ (run "configfile scripts list" to see available scripts)')
  }
  if (script === 'other-system') {
    const reason = noVersionFor(ctx.platform)
    ctx.output.info(`The ${hook} script of the repository, "${name}", has ${reason}, skipped.`)
    ctx.history.record({ kind: 'script-skipped', name, hook, reason })
    return { ok: true }
  }

  ctx.output.info(`Running "${script.name}", the ${hook} script of the repository…`)
  let code: number
  let signal: NodeJS.Signals | undefined
  try {
    code = await runScript(script, [], {
      cwd: ctx.cwd,
      onSignal: received => {
        signal ??= received
      },
      env: {
        ...scriptEnvironment(script, scripts.repository, ctx.platform, scripts.profiles),
        CONFIGFILE_HOOK: hook,
      },
    })
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    return failed(`cannot be run: ${messageOf(error)}`)
  }
  ctx.history.record({ kind: 'script', name: script.name, file: script.path, exitCode: code, hook })
  if (signal != null) return failed(`was stopped (${signal})`, signal)
  return code === 0 ? { ok: true } : failed(`exited with code ${code}`)
}

/**
 * The error of a command whose repository script did not run to the end:
 * what was done already, why, and how to run it again. Stopped by a signal,
 * the command exits as the script did.
 */
export function failedHook(
  outcome: Extract<HookOutcome, { ok: false }>,
  { done, hook, name }: { done: string; hook: RepositoryHook; name: string },
): CliError {
  const exitCode = outcome.signal == null ? 1 : 128 + (osConstants.signals[outcome.signal] ?? 0)
  return new CliError(
    `${done}, but the ${hook} script of the repository, "${name}", ${outcome.reason}: once ` +
      `fixed, run it with ` +
      `"configfile scripts run ${name}".`,
    { exitCode },
  )
}

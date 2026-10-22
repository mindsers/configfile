import type { Context } from './context.ts'
import { messageOf } from './fsutil.ts'
import { runScript } from './process.ts'
import {
  loadScripts,
  type RepositoryHook,
  type Script,
  scriptEnvironment,
  systemName,
} from './repository.ts'

/** Where a script a setting names is: found, only made for other systems, or missing. */
export function findScript(
  name: string,
  {
    scripts,
    otherSystems,
  }: Pick<Awaited<ReturnType<typeof loadScripts>>, 'scripts' | 'otherSystems'>,
): Script | 'other-system' | 'missing' {
  const script = scripts.find(candidate => candidate.name === name)
  if (script != null) return script
  return otherSystems.includes(name) ? 'other-system' : 'missing'
}

/**
 * Runs the script a setting of the repository names (`post_update`,
 * `post_init`), like `configfile scripts run`, with `CONFIGFILE_HOOK`, and
 * records it. A script only made for other systems is skipped, with a
 * message. Returns `false` when the script is missing, cannot be started or
 * fails, after saying why: the caller says what was done already.
 */
export async function runRepositoryHook(
  hook: RepositoryHook,
  name: string,
  ctx: Context,
): Promise<boolean> {
  const scripts = await loadScripts(ctx)
  const script = findScript(name, scripts)
  if (script === 'missing') {
    ctx.output.error(
      `The ${hook} script of the repository, "${name}", is not in scripts/. ` +
        'Run "configfile scripts list" to see available scripts.',
    )
    return false
  }
  if (script === 'other-system') {
    const reason = `no version for ${systemName(ctx.platform)}`
    ctx.output.info(`The ${hook} script of the repository, "${name}", has ${reason}, skipped.`)
    ctx.history.record({ kind: 'script-skipped', name, hook, reason })
    return true
  }

  ctx.output.info(`Running "${script.name}", the ${hook} script of the repository…`)
  let code: number
  try {
    code = await runScript(script, [], {
      cwd: ctx.cwd,
      env: {
        ...scriptEnvironment(script, scripts.repository, ctx.platform, scripts.profiles),
        CONFIGFILE_HOOK: hook,
      },
    })
  } catch (error) {
    ctx.output.error(`The ${hook} script of the repository, "${name}": ${messageOf(error)}`)
    return false
  }
  ctx.history.record({ kind: 'script', name: script.name, file: script.path, exitCode: code, hook })
  if (code !== 0) {
    ctx.output.error(`The ${hook} script of the repository, "${name}", exited with code ${code}.`)
  }
  return code === 0
}

import { lstat } from 'node:fs/promises'
import path from 'node:path'

import type { Command } from 'commander'

import { ConfigStore } from '../config.ts'
import type { Context } from '../context.ts'
import { CliError } from '../errors.ts'
import { errnoCode, messageOf } from '../fsutil.ts'
import { plural } from '../output.ts'
import { configfilePaths } from '../paths.ts'
import { ensureGit } from '../process.ts'
import { findRemovedFiles } from '../removed.ts'
import { loadRepository } from '../repository.ts'
import { DeploymentRecord } from '../state.ts'
import { syncMirror } from '../sync.ts'

export function registerUpdateCommand(program: Command, ctx: Context): void {
  program
    .command('update')
    .alias('u')
    .description("sync configfile's copy of your dotfiles repository with the remote")
    .action(() => update(ctx))
}

async function update(ctx: Context): Promise<void> {
  const { output } = ctx
  const { folderPath } = await new ConfigStore(ctx.home, {
    warn: message => ctx.output.warn(message),
  }).read()

  try {
    await lstat(path.join(folderPath, '.git'))
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      throw new CliError(`${folderPath} is not a git repository. Run "configfile init --force".`)
    }
    throw new CliError(`Cannot read ${folderPath}: ${messageOf(error)}`, { cause: error })
  }

  await ensureGit()
  output.info(`Syncing ${folderPath}…`)
  const result = await syncMirror(folderPath, configfilePaths(ctx.home).saved, {
    onSaved: file => ctx.history.record({ kind: 'saved-patch', file }),
  })
  ctx.history.record({
    kind: 'synced',
    folder: folderPath,
    upstream: result.upstream,
    from: result.before,
    to: result.after,
  })

  if (result.saved != null) {
    output.warn(
      `${folderPath} had local changes: they were saved to ${result.saved} and replaced by ` +
        `${result.upstream}. Edit your dotfiles in your own working copy; to keep these changes, ` +
        `apply them there with: git am ${result.saved}`,
    )
  }

  if (result.before === result.after) {
    output.success(`Already up to date with ${result.upstream}.`)
  } else {
    output.success(
      `Synced with ${result.upstream} (${result.after.slice(0, 7)}). Global files are links, so ` +
        'they are up to date; run "configfile modules deploy --all" for new files.',
    )
  }
  await warnAboutRemovedFiles(ctx)
}

/**
 * Deployed files whose entry left the repository stay in place until they are
 * undeployed: says so. Never fails, the sync is already done.
 */
async function warnAboutRemovedFiles(ctx: Context): Promise<void> {
  const { output } = ctx
  try {
    const { repository, modules } = await loadRepository(ctx)
    const record = await DeploymentRecord.load(ctx.home)
    const find = async (strategy: 'global' | 'local') =>
      (await findRemovedFiles(record, modules, { repository, home: ctx.home, strategy })).removed
    const global = await find('global')
    const local = await find('local')
    const count = global.length + local.length
    if (count === 0) return

    const one = count === 1
    const targets = [...global, ...local].map(file => file.target).join(', ')
    // A local copy is undeployed from the folder it was copied into.
    const folders = [...new Set(local.map(file => file.folder))].filter(folder => folder != null)
    const steps = [
      global.length > 0 ? 'run "configfile modules undeploy --removed"' : null,
      local.length > 0
        ? `run "configfile modules undeploy --removed --local" in ${folders.join(', ')}`
        : null,
    ].filter(step => step != null)
    output.warn(
      `${plural(count, 'deployed file')} ${one ? 'is' : 'are'} no longer deployed by the ` +
        `repository: ${targets}. To remove ${one ? 'it' : 'them'} and restore what ` +
        `${one ? 'it' : 'they'} replaced, ${steps.join(', and ')}.`,
    )
  } catch (error) {
    output.warn(`Cannot check for files the repository no longer deploys: ${messageOf(error)}`)
    if (!(error instanceof CliError) && process.env.DEBUG != null) {
      output.stderr.write(`${(error as Error).stack}\n`)
    }
  }
}

import { lstat } from 'node:fs/promises'
import path from 'node:path'

import type { Command } from 'commander'

import { ConfigStore } from '../config.js'
import type { Context } from '../context.js'
import { CliError } from '../errors.js'
import { errnoCode, messageOf } from '../fsutil.js'
import { plural } from '../output.js'
import { configfilePaths } from '../paths.js'
import { findRemovedFiles } from '../removed.js'
import { loadRepository } from '../repository.js'
import { DeploymentRecord } from '../state.js'
import { syncMirror } from '../sync.js'

export function registerUpdateCommand(program: Command, ctx: Context): void {
  program
    .command('update')
    .alias('u')
    .description("sync configfile's copy of your dotfiles repository with the remote")
    .action(() => update(ctx))
}

async function update(ctx: Context): Promise<void> {
  const { output } = ctx
  const { folderPath } = await new ConfigStore(ctx.home).read()

  try {
    await lstat(path.join(folderPath, '.git'))
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      throw new CliError(`${folderPath} is not a git repository. Run "configfile init --force".`)
    }
    throw new CliError(`Cannot read ${folderPath}: ${messageOf(error)}`)
  }

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
    const find = (strategy: 'global' | 'local') =>
      findRemovedFiles(record, modules, { repository, strategy })
    const global = await find('global')
    const local = await find('local')
    if (global.length + local.length === 0) return

    const count = global.length + local.length
    const one = count === 1
    const targets = [...global, ...local].map(file => file.target).join(', ')
    const steps = [
      global.length > 0 ? 'run "configfile modules undeploy --removed"' : null,
      local.length > 0
        ? 'run "configfile modules undeploy --removed --local" in the folders of the local copies'
        : null,
    ].filter(step => step != null)
    output.warn(
      `${plural(count, 'deployed file')} ${one ? 'is' : 'are'} no longer deployed by the ` +
        `repository: ${targets}. To remove ${one ? 'it' : 'them'} and restore what ` +
        `${one ? 'it' : 'they'} replaced, ${steps.join(', and ')}.`,
    )
  } catch (error) {
    output.warn(`Cannot check for files the repository no longer deploys: ${messageOf(error)}`)
  }
}

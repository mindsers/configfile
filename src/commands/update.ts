import { lstat } from 'node:fs/promises'
import path from 'node:path'

import type { Command } from 'commander'

import { ConfigStore } from '../config.js'
import type { Context } from '../context.js'
import { CliError } from '../errors.js'
import { errnoCode, messageOf } from '../fsutil.js'
import { configfilePaths } from '../paths.js'
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
  const result = await syncMirror(folderPath, configfilePaths(ctx.home).saved)

  if (result.saved != null) {
    output.warn(
      `${folderPath} had local changes: they were saved to ${result.saved} and replaced by ` +
        `${result.upstream}. Edit your dotfiles in your own working copy; to keep these changes, ` +
        `apply them there with: git am ${result.saved}`,
    )
  }

  if (result.before === result.after) {
    output.success(`Already up to date with ${result.upstream}.`)
    return
  }
  output.success(
    `Synced with ${result.upstream} (${result.after.slice(0, 7)}). Global files are links, so ` +
      'they are up to date; run "configfile modules deploy --all" for new files.',
  )
}

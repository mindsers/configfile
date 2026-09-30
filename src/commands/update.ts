import { lstat } from 'node:fs/promises'
import path from 'node:path'

import type { Command } from 'commander'

import { ConfigStore } from '../config.js'
import type { Context } from '../context.js'
import { CliError } from '../errors.js'
import { gitPull } from '../process.js'

export function registerUpdateCommand(program: Command, ctx: Context): void {
  program
    .command('update')
    .alias('u')
    .description('pull the latest version of your dotfiles repository')
    .action(() => update(ctx))
}

async function update(ctx: Context): Promise<void> {
  const { folderPath } = await new ConfigStore(ctx.home).read()

  try {
    await lstat(path.join(folderPath, '.git'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(`${folderPath} is not a git repository. Run "configfile init".`)
    }
    throw new CliError(`Cannot read ${folderPath}: ${(error as Error).message}`)
  }

  ctx.output.info(`Updating ${folderPath}…`)
  await gitPull(folderPath)
  ctx.output.success(
    'Dotfiles updated. Global files are symbolic links, so they are already up to date; ' +
      'run "configfile modules deploy" for new files.',
  )
}

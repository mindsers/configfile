import { lstat } from 'node:fs/promises'
import path from 'node:path'

import type { Command } from 'commander'

import { ConfigStore } from '../config.ts'
import type { Context } from '../context.ts'
import { applyCopy, type CopiedFile, inspectCopy, isRecordFor, recordIdentical } from '../copy.ts'
import { assertUsableSource, Guard, isGlobalCopy } from '../deploy.ts'
import { CliError } from '../errors.ts'
import { errnoCode, lstatOrNull, messageOf } from '../fsutil.ts'
import { withCommandLock } from '../lock.ts'
import { RepositoryView } from '../mirror.ts'
import { plural } from '../output.ts'
import { configfilePaths } from '../paths.ts'
import { ensureGit } from '../process.ts'
import { findRemovedFiles, type RecordedFile } from '../removed.ts'
import { loadRepository, type Module, type ModuleFile } from '../repository.ts'
import { DeploymentRecord } from '../state.ts'
import { syncMirror } from '../sync.ts'
import {
  addedCopyEntries,
  type EntryKey,
  openWorkingCopy,
  push,
  syncedFromBranch,
  type WorkingCopy,
} from '../working-copy.ts'
import { describeDeploy, recordDeploy } from './modules.ts'

export function registerUpdateCommand(program: Command, ctx: Context): void {
  program
    .command('update')
    .alias('u')
    .description(
      "sync configfile's copy of your dotfiles repository with the remote, and the global files copied from it",
    )
    .action(() => update(ctx))
}

async function update(ctx: Context): Promise<void> {
  const { folderPath, workingCopy } = await new ConfigStore(ctx.home, {
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
  // Before syncing, so that the mirror gets what the working copy commits.
  const copy = workingCopy == null ? null : await pushWorkingCopy(ctx, workingCopy, folderPath)
  await syncAndRefresh(ctx, folderPath, { workingCopy: copy })
}

/**
 * Pushes the commits of the working copy that the remote lacks. Never fails:
 * the sync goes on without them. Returns the working copy, or `null` when it
 * cannot be used.
 */
async function pushWorkingCopy(
  ctx: Context,
  folder: string,
  mirror: string,
): Promise<WorkingCopy | null> {
  let copy: WorkingCopy
  try {
    copy = await openWorkingCopy(folder, mirror)
  } catch (error) {
    ctx.output.warn(`Cannot use your working copy (${folder}): ${messageOf(error)}`)
    return null
  }
  try {
    const pushed = await push(copy)
    if (pushed != null) {
      ctx.history.record({ kind: 'pushed', folder, branch: copy.branch, ...pushed })
      ctx.output.info(`Pushed ${copy.branch} from ${folder} to ${copy.remote}.`)
    }
  } catch (error) {
    ctx.output.warn(`Cannot push your working copy (${folder}): ${messageOf(error)}`)
  }
  return copy
}

/**
 * The copied entries added by the commits of the working copy's branch that
 * the sync brought (see `syncedFromBranch`): an identical file at their
 * target is one the user adopted, or one already in place for a commit the
 * user pulled there. Commits pushed from elsewhere do not count. Never
 * fails: what it cannot read is reported, and those files are left to
 * `modules deploy`.
 */
async function adoptedEntries(
  ctx: Context,
  folderPath: string,
  copy: WorkingCopy | null,
  { before, after }: { before: string | null; after: string },
): Promise<EntryKey[]> {
  if (copy == null || before == null || before === after) return []
  try {
    const range = await syncedFromBranch(copy, folderPath, { before, after })
    return range == null ? [] : await addedCopyEntries(folderPath, range)
  } catch (error) {
    ctx.output.warn(
      `Cannot tell which files the new commits of your working copy added (${messageOf(error)}): ` +
        'files you adopted are not kept as configfile\'s copies. "configfile modules deploy" ' +
        'deploys them, moving yours to .old.',
    )
    return []
  }
}

/**
 * Syncs the mirror with the remote, then updates the copies of global files.
 * With the working copy, it also records as configfile's copies the
 * unrecorded targets of the copied entries that its synced commits added,
 * when they already are the repository's version, and warns about those
 * that differ (see `adoptedEntries`). Reports what it did. `deployHint` says
 * to deploy the new files (not after `modules adopt`, whose files are already
 * in place).
 */
export async function syncAndRefresh(
  ctx: Context,
  folderPath: string,
  { workingCopy, deployHint = true }: { workingCopy: WorkingCopy | null; deployHint?: boolean },
): Promise<Refresh> {
  const { output } = ctx
  // Deployments read the mirror, which the sync replaces: they never overlap.
  const { result, refreshed } = await withCommandLock(ctx, async () => {
    output.info(`Syncing ${folderPath}…`)
    const result = await syncMirror(folderPath, configfilePaths(ctx.home).saved, {
      onSaved: (file, paths) =>
        ctx.history.record({ kind: 'saved-patch', file, paths: [...paths] }),
    })
    ctx.history.record({
      kind: 'synced',
      folder: folderPath,
      upstream: result.upstream,
      from: result.before,
      to: result.after,
    })
    const adopted = await adoptedEntries(ctx, folderPath, workingCopy, result)
    // Copies follow the repository too, before any deployment can start.
    return { result, refreshed: await refreshCopies(ctx, folderPath, adopted) }
  })

  if (result.saved != null) {
    output.warn(
      `${folderPath} had changes that ${result.upstream} doesn't have, to ` +
        `${listPaths(result.savedPaths)}: they were saved to ${result.saved} and replaced by ` +
        `${result.upstream}. Edit your dotfiles in your own working copy; to keep these ` +
        `changes, apply them there, then commit and push: ` +
        `git -C <your working copy> apply --3way ${result.saved}`,
    )
  }

  if (result.before === result.after) {
    output.success(`Already up to date with ${result.upstream}.`)
  } else {
    const hint = deployHint ? ' Run "configfile modules deploy --all" for new files.' : ''
    output.success(`Synced with ${result.upstream} (${result.after.slice(0, 7)}).${hint}`)
  }
  reportRefresh(refreshed, ctx)
  if (refreshed.modules != null) {
    await warnAboutRemovedFiles(ctx, folderPath, refreshed.modules)
  } else if (refreshed.problem != null) {
    output.warn(`Cannot check for files the repository no longer deploys: ${refreshed.problem}`)
  }
  return refreshed
}

/** What following the repository did to the copies of global files. */
export interface Refresh {
  /** The repository's modules, read after the sync; `null` when they cannot be, and why. */
  readonly modules: Module[] | null
  /** Why the modules or the record cannot be read. */
  readonly problem: string | null
  /** Copies with files changed on this machine, kept. */
  readonly kept: string[]
  /** Copies with files changed both here and in the repository, and their module. */
  readonly conflicts: { target: string; module: string; paths: readonly string[] }[]
  /** Copies with files configfile could not update, and why. */
  readonly left: { target: string; module: string; reasons: readonly string[] }[]
  /** Global files the repository copies, still deployed as configfile's links. */
  readonly linked: string[]
  /** Copies that need `modules deploy` (or a fixed module), and why. */
  readonly waiting: { target: string; reason: string }[]
  /** Targets of adopted entries recorded as configfile's copies. */
  readonly recorded: string[]
  /** Targets of adopted entries left as they are: not the repository's version. */
  readonly differing: { target: string; module: string }[]
}

/**
 * Updates configfile's copies of global files where nothing changed them on
 * this machine, as links follow the repository by themselves. Never moves
 * anything aside, never asks, never runs a module's scripts: what changed on
 * this machine is kept, and conflicts wait for `modules deploy`. Never fails,
 * the sync is already done: what it could not do is reported.
 */
async function refreshCopies(
  ctx: Context,
  repository: string,
  adopted: readonly EntryKey[],
): Promise<Refresh> {
  const refresh: Refresh = {
    modules: null,
    problem: null,
    kept: [],
    conflicts: [],
    left: [],
    linked: [],
    waiting: [],
    recorded: [],
    differing: [],
  }
  let modules: Module[]
  let record: DeploymentRecord
  try {
    modules = (await loadRepository(ctx)).modules
    record = await DeploymentRecord.load(ctx.home)
  } catch (error) {
    ctx.output.warn(`Cannot update the copies of global files: ${messageOf(error)}`)
    return { ...refresh, problem: messageOf(error) }
  }
  const guard = new Guard({ home: ctx.home, cwd: ctx.cwd })
  const view = new RepositoryView(repository)
  const seen = new Set<string>()

  for (const module of modules) {
    if (module.error != null) continue
    for (const file of module.files.filter(isGlobalCopy)) {
      try {
        const existing = await lstatOrNull(file.target)
        if (existing == null) continue
        const known = (await record.find(file.target))?.deployed
        if (known == null && isAdopted(file, adopted)) {
          if (await recordIdentical(file, record, view)) {
            refresh.recorded.push(file.target)
            ctx.history.record({ kind: 'recorded', target: file.target, source: file.source })
          } else {
            refresh.differing.push({ target: file.target, module: module.name })
          }
          continue
        }
        if (known == null || !isRecordFor(known, file)) continue
        seen.add(file.target)
        if (existing.isSymbolicLink()) {
          if (known.copy == null) refresh.linked.push(file.target)
          continue
        }
        // Only configfile's own copies: anything else waits for a deployment.
        if (known.copy == null) continue

        await assertUsableSource(file)
        // Files change inside the copy: it may be the current folder.
        await guard.check(file, { inPlace: true })
        const state = await inspectCopy(file, record, view)
        if (state.kind !== 'copy') {
          refresh.waiting.push({
            target: file.target,
            reason: `deploy it again: run "configfile modules deploy ${module.name}"`,
          })
          continue
        }
        const { files } = await applyCopy(file, state.plan, { replace: 'none', record })
        report(file, files, module.name, refresh, ctx)
      } catch (error) {
        ctx.output.warn(`Cannot update ${file.target}: ${messageOf(error)}`)
        ctx.history.record({ kind: 'failed', target: file.target, reason: messageOf(error) })
      }
    }
  }

  // Copies of modules the repository cannot use now are not updated: said, not skipped silently.
  const byFolder = new Map(modules.map(module => [path.relative(repository, module.path), module]))
  for (const { target, deployed } of record.targets()) {
    if (deployed?.copy == null || deployed.entry == null || seen.has(target)) continue
    const module = byFolder.get(deployed.entry.module)
    if (module?.error != null) {
      refresh.waiting.push({
        target,
        reason: `module "${module.name}" cannot be used: ${module.error}`,
      })
    } else if (module != null && module.invalidEntries.length > 0) {
      refresh.waiting.push({ target, reason: `module "${module.name}" has invalid entries` })
    }
  }
  return { ...refresh, modules }
}

function isAdopted(file: ModuleFile, adopted: readonly EntryKey[]): boolean {
  const { entry } = file
  if (entry == null) return false
  const module = entry.module.split(path.sep).join('/')
  return adopted.some(key => key.module === module && key.source === path.normalize(entry.source))
}

/** Prints and records what updating a copy did, and keeps what is said once at the end. */
function report(
  file: ModuleFile,
  files: readonly CopiedFile[],
  module: string,
  refresh: Refresh,
  ctx: Context,
): void {
  if (files.length === 0) {
    ctx.history.unchanged()
    return
  }
  recordDeploy(file, { status: 'updated', outcome: { files } }, ctx)
  const changed = files.filter(item => ['created', 'updated', 'deleted'].includes(item.result))
  if (changed.length > 0) {
    ctx.output.print(
      `- ${file.target} ${describeDeploy(file, { status: 'updated', outcome: { files: changed } })}`,
    )
  }
  if (files.some(item => item.result === 'kept')) refresh.kept.push(file.target)
  const conflicts = files.filter(item => item.result === 'conflict' && item.reason == null)
  if (conflicts.length > 0) {
    refresh.conflicts.push({ target: file.target, module, paths: conflicts.map(item => item.path) })
  }
  const left = files.filter(item => item.result === 'failed' || item.reason != null)
  if (left.length > 0) {
    const reasons = [
      ...new Set(
        left.map(item => `${item.path === '' ? '' : `${item.path}: `}${item.reason ?? 'failed'}`),
      ),
    ]
    refresh.left.push({ target: file.target, module, reasons })
  }
}

function reportRefresh(refresh: Refresh, ctx: Context): void {
  const { output } = ctx
  for (const target of refresh.recorded) {
    output.print(`- ${target} (configfile's copy now)`)
  }
  for (const { target, module } of refresh.differing) {
    // Changed since it was committed, or the repository changed it meanwhile.
    output.warn(
      `${target} is not the repository's version, so configfile left it as it is: ` +
        `"configfile modules deploy ${module}" would move it to .old and copy the ` +
        "repository's version.",
    )
  }
  if (refresh.kept.length > 0) {
    output.info(
      `Kept what changed on this machine in ${listPaths(refresh.kept)} ` +
        '("configfile modules status" shows it).',
    )
  }
  for (const { target, module, paths } of refresh.conflicts) {
    const what =
      paths.length === 1 && paths[0] === ''
        ? `${target} changed both on this machine and in the repository, and was left as it is`
        : `In ${target}, ${listPaths(paths)} changed both on this machine and in the repository, ` +
          `and ${paths.length === 1 ? 'was' : 'were'} left as ${paths.length === 1 ? 'it is' : 'they are'}`
    output.warn(`${what}: run "configfile modules deploy ${module}" to choose.`)
  }
  for (const { target, reasons } of refresh.left) {
    output.warn(`${target} could not be fully updated: ${reasons.join('; ')}.`)
  }
  for (const { target, reason } of refresh.waiting) {
    output.warn(`${target} was not updated: ${reason}.`)
  }
  if (refresh.linked.length > 0) {
    const one = refresh.linked.length === 1
    output.info(
      `${plural(refresh.linked.length, 'global file')} ${one ? 'is' : 'are'} still linked to ` +
        `configfile's copy of the repository (${listPaths(refresh.linked)}): run ` +
        `"configfile modules deploy --all" to copy ${one ? 'it' : 'them'}.`,
    )
  }
}

/** `a, b and c`, or the first ones and how many more. */
export function listPaths(paths: readonly string[], shown = 10): string {
  if (paths.length > shown) {
    return `${paths.slice(0, shown).join(', ')} and ${paths.length - shown} more`
  }
  if (paths.length <= 1) return paths.join('')
  return `${paths.slice(0, -1).join(', ')} and ${paths.at(-1)}`
}

/**
 * The commands that undeploy these files: local copies from the folders
 * they were copied into.
 */
function undeploySteps(files: readonly RecordedFile[]): string {
  const local = files.filter(file => file.strategy === 'local')
  const folders = [...new Set(local.map(file => file.folder))].filter(folder => folder != null)
  return [
    files.some(file => file.strategy === 'global')
      ? 'run "configfile modules undeploy --removed"'
      : null,
    local.length > 0
      ? `run "configfile modules undeploy --removed --local" in ${folders.join(', ')}`
      : null,
  ]
    .filter(step => step != null)
    .join(', and ')
}

/**
 * Deployed files whose entry left the repository stay in place until they are
 * undeployed: says so. Never fails, the sync is already done.
 */
async function warnAboutRemovedFiles(
  ctx: Context,
  repository: string,
  modules: Module[],
): Promise<void> {
  const { output } = ctx
  try {
    const record = await DeploymentRecord.load(ctx.home)
    const find = async (strategy: 'global' | 'local') =>
      (await findRemovedFiles(record, modules, { repository, home: ctx.home, strategy })).removed
    const found = [...(await find('global')), ...(await find('local'))]
    // Their entry is still there, for other machines: maybe the profiles are wrong.
    const notHere = found.filter(file => file.notHere != null)
    if (notHere.length > 0) {
      const one = notHere.length === 1
      output.warn(
        `${plural(notHere.length, 'deployed file')} ${one ? 'is' : 'are'} no longer for this ` +
          `machine: ${notHere.map(file => `${file.target} (${file.notHere})`).join(', ')}. ` +
          `If "profiles" in ${configfilePaths(ctx.home).rc} is right, ` +
          `${undeploySteps(notHere)} to remove ${one ? 'it' : 'them'}.`,
      )
    }
    const global = found.filter(file => file.notHere == null && file.strategy === 'global')
    const local = found.filter(file => file.notHere == null && file.strategy === 'local')
    const count = global.length + local.length
    if (count === 0) return

    const one = count === 1
    const targets = [...global, ...local].map(file => file.target).join(', ')
    output.warn(
      `${plural(count, 'deployed file')} ${one ? 'is' : 'are'} no longer deployed by the ` +
        `repository: ${targets}. To remove ${one ? 'it' : 'them'} and restore what ` +
        `${one ? 'it' : 'they'} replaced, ${undeploySteps([...global, ...local])}.`,
    )
  } catch (error) {
    output.warn(`Cannot check for files the repository no longer deploys: ${messageOf(error)}`)
    if (!(error instanceof CliError) && process.env.DEBUG != null) {
      output.stderr.write(`${(error as Error).stack}\n`)
    }
  }
}

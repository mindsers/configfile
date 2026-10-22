import type { Command } from 'commander'

import type { Context } from '../context.ts'
import { CliError } from '../errors.ts'
import type { Change, HistoryLine, KeptReason } from '../history.ts'
import { plural } from '../output.ts'

const DEFAULT_LIMIT = 20

/** Width of the verb that starts each change line. */
const VERB_WIDTH = 9

interface HistoryOptions {
  limit?: string
  json?: boolean
}

export function registerHistoryCommand(program: Command, ctx: Context): void {
  program
    .command('history')
    .description('show what configfile changed, most recent last')
    .option('-n, --limit <count>', `number of runs to show (default: ${DEFAULT_LIMIT})`)
    .option('--json', 'print the raw history lines (JSON Lines), for scripts')
    .action((options: HistoryOptions) => history(options, ctx))
}

async function history(options: HistoryOptions, ctx: Context): Promise<void> {
  const { output } = ctx
  const limit = parseLimit(options.limit)
  const [{ entries, invalid, problems }, settings] = await Promise.all([
    ctx.history.read(),
    ctx.history.settings(),
  ])

  if (settings.warning != null) output.warn(settings.warning)
  for (const problem of problems) output.warn(problem)
  if (invalid > 0) output.warn(`${plural(invalid, 'damaged line')} of the history skipped.`)

  if (options.json === true) {
    // The lines as written, newer formats included: scripts decide what they read.
    for (const entry of entries.slice(-limit)) output.stdout.write(`${entry.raw}\n`)
    return
  }

  const readable = entries.filter(entry => entry.line != null)
  const newer = entries.length - readable.length
  if (newer > 0) {
    output.warn(
      `${plural(newer, 'line')} written by a newer configfile skipped. Update configfile to see them.`,
    )
  }

  if (readable.length === 0) {
    if (settings.maxBytes === 0 && settings.warning == null) {
      output.info('The history is turned off ("history_max_size" is 0 in ~/.configfilerc).')
    } else {
      output.info(
        entries.length + invalid + problems.length > 0 ? 'No readable history.' : 'No history yet.',
      )
    }
    return
  }

  const show = (text: string) => shortenHome(text, ctx.home)
  for (const [index, { line, unreadableChanges }] of readable.slice(-limit).entries()) {
    if (line == null) continue
    if (index > 0) output.print('')
    output.print(
      `${formatTime(line.time)}  ${show(describeRun(line))}  ${line.exitCode === 0 ? 'ok' : `exit ${line.exitCode}`}`,
    )
    for (const change of line.changes) {
      output.print(`  ${show(describeChange(change))}`)
    }
    if (unreadableChanges > 0) {
      output.print(`  …and ${plural(unreadableChanges, 'change')} this configfile cannot show`)
    }
    if (line.truncated != null) output.print(`  …and ${line.truncated} more changes`)
    if (line.unchanged > 0) output.print(`  ${line.unchanged} unchanged`)
    if (line.error != null) {
      // Expected errors explain most failures (a held lock, a failed git fetch…).
      const label = line.error.expected ? 'error' : 'crashed'
      output.print(`  ${label.padEnd(VERB_WIDTH)} ${show(line.error.message)}`)
    }
  }
}

function parseLimit(value: string | undefined): number {
  if (value == null) return DEFAULT_LIMIT
  const limit = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new CliError(`--limit must be a positive number, not "${value}".`)
  }
  return limit
}

/** The command line of a run, rebuilt from its recorded options. */
function describeRun(line: HistoryLine): string {
  const options = line.options
  const words = [line.command ?? '(unknown command)']

  if (Array.isArray(options.modules)) words.push(...options.modules.map(String))
  if (typeof options.script === 'string') words.push(options.script)
  if (typeof options.repo === 'string') words.push('--repo', options.repo)
  if (typeof options.folder === 'string') words.push('--folder', options.folder)
  if (typeof options.workingCopy === 'string') words.push('--working-copy', options.workingCopy)
  if (typeof options.paths === 'number') words.push(`(${plural(options.paths, 'path')})`)
  if (typeof options.module === 'string') words.push('--module', options.module)
  for (const flag of ['local', 'all', 'force', 'removed'] as const) {
    if (options[flag] === true) words.push(`--${flag}`)
  }
  if (options.keepGoing === true) words.push('--keep-going')
  if (typeof options.os === 'string') words.push('--os', options.os)
  if (Array.isArray(options.profile)) {
    for (const name of options.profile) words.push('--profile', String(name))
  }
  if (options.hooks === false) words.push('--no-hooks')
  if (options.hooks === true) words.push('--hooks')
  if (options.push === false) words.push('--no-push')
  if (typeof options.argCount === 'number' && options.argCount > 0) {
    words.push(`(${plural(options.argCount, 'argument')})`)
  }
  return words.join(' ')
}

/** One change, as an aligned line: a verb, then what it applies to. */
function describeChange(change: Change): string {
  const line = (verb: string, text: string) => `${verb.padEnd(VERB_WIDTH)} ${text}`

  switch (change.kind) {
    case 'deployed': {
      const moved = change.backup == null ? '' : `  (previous file moved to ${change.backup})`
      if (change.replaced === 'copy' && change.how === 'copy') {
        return line('updated', `${change.target}${moved}`)
      }
      const was = change.replaced == null ? '' : `  (was a ${change.replaced})`
      return line(change.how === 'link' ? 'linked' : 'copied', `${change.target}${moved}${was}`)
    }
    case 'skipped': {
      const reason =
        change.reason === 'conflict' ? 'changed here and in the repository' : 'it already existed'
      return line('skipped', `${change.target}  (${reason})`)
    }
    case 'removed': {
      const backup =
        change.backup == null
          ? ''
          : {
              restored: `  (${change.backup.path} restored)`,
              missing: `  (its backup ${change.backup.path} no longer existed)`,
              changed: `  (its backup ${change.backup.path} had changed, not restored)`,
            }[change.backup.status]
      const leftover = change.leftover == null ? '' : `  (left at ${change.leftover})`
      const moved = change.movedTo == null ? '' : `  (yours moved to ${change.movedTo})`
      return line('removed', `${change.target}${backup}${leftover}${moved}`)
    }
    case 'kept': {
      const reason: Record<KeptReason, string> = {
        changed: 'changed on this machine',
        foreign: 'not deployed by configfile',
        modified: 'modified since it was copied',
        identical: 'not copied by configfile',
        'source-missing': 'its source was missing',
      }
      const forgotten = change.forgotten === true ? '; configfile no longer tracks it' : ''
      return line('kept', `${change.target}  (${reason[change.reason]}${forgotten})`)
    }
    case 'failed':
      return line(
        'failed',
        `${'target' in change ? change.target : `module ${change.module}`}  ${change.reason}`,
      )
    case 'synced':
      return line(
        'synced',
        change.from === change.to
          ? `${change.folder}  (already up to date with ${change.upstream})`
          : `${change.folder}  with ${change.upstream} (${short(change.from)} → ${short(change.to)})`,
      )
    case 'saved-patch': {
      const paths = change.paths == null ? '' : `  (${change.paths.join(', ')})`
      return line('saved', `local changes to ${change.file}${paths}`)
    }
    case 'script':
      return line(
        'script',
        `${change.name}  exit ${change.exitCode}` +
          (change.module != null
            ? `  (${change.hook ?? 'hook'} of ${change.module})`
            : change.hook != null
              ? `  (${change.hook} of the repository)`
              : ''),
      )
    case 'script-skipped':
      return line(
        'skipped',
        `${change.name}  (${change.hook} of ${change.module ?? 'the repository'}: ${change.reason})`,
      )
    case 'cloned':
      return line('cloned', `${change.repository} into ${change.folder}`)
    case 'reused':
      return line('reused', `${change.folder} for ${change.repository}`)
    case 'configured':
      return line('saved', `configuration ${change.file}`)
    case 'adopted':
      return line(
        'adopted',
        `${change.target}  (committed as ${change.source} in ${change.folder})`,
      )
    case 'pushed':
      return line(
        'pushed',
        `${change.folder}  ${change.branch} (${short(change.from)} → ${short(change.to)})`,
      )
    case 'recorded':
      return line('recorded', `${change.target}  (configfile's copy of ${change.source})`)
  }
}

function short(commit: string | null): string {
  return commit == null ? 'nothing' : commit.slice(0, 7)
}

/** `2026-10-01 11:12`, in local time. */
function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** Shows paths in the home folder as `~/…` (display only; the file keeps full paths). */
function shortenHome(text: string, home: string): string {
  return text.split(`${home}/`).join('~/')
}

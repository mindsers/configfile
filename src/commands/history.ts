import type { Command } from 'commander'

import type { Context } from '../context.js'
import { CliError } from '../errors.js'
import type { Change, HistoryLine } from '../history.js'
import { plural } from '../output.js'

const DEFAULT_LIMIT = 20

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
  const { lines, invalid } = await ctx.history.read({ limit })

  if (invalid > 0) {
    output.warn(`${plural(invalid, 'unreadable line')} of ${ctx.history.file} skipped.`)
  }

  if (options.json === true) {
    for (const line of lines) output.stdout.write(`${JSON.stringify(line)}\n`)
    return
  }

  if (lines.length === 0) {
    const { maxBytes } = await ctx.history.settings()
    output.info(
      maxBytes === 0
        ? 'The history is turned off ("history_max_size" is 0 in ~/.configfilerc).'
        : 'No history yet.',
    )
    return
  }

  const show = (text: string) => shortenHome(text, ctx.home)
  for (const [index, line] of lines.entries()) {
    if (index > 0) output.print('')
    output.print(
      `${formatTime(line.time)}  ${show(describeRun(line))}  ${line.exitCode === 0 ? 'ok' : `exit ${line.exitCode}`}`,
    )
    if (line.error != null && !line.error.expected) {
      output.print(`  error     ${show(line.error.message)}`)
    }
    for (const change of line.changes) {
      output.print(`  ${show(describeChange(change))}`)
    }
    if (line.truncated != null) output.print(`  …and ${line.truncated} more changes`)
    if (line.unchanged > 0) output.print(`  ${line.unchanged} unchanged`)
  }
}

function parseLimit(value: string | undefined): number {
  if (value == null) return DEFAULT_LIMIT
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit <= 0) {
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
  for (const flag of ['local', 'all', 'force'] as const) {
    if (options[flag] === true) words.push(`--${flag}`)
  }
  if (typeof options.argCount === 'number' && options.argCount > 0) {
    words.push(`(${plural(options.argCount, 'argument')})`)
  }
  return words.join(' ')
}

/** One change, as an aligned line: a verb, then what it applies to. */
function describeChange(change: Change): string {
  const line = (verb: string, text: string) => `${verb.padEnd(9)} ${text}`

  switch (change.kind) {
    case 'deployed': {
      const moved = change.backup == null ? '' : `  (previous file moved to ${change.backup})`
      return line(change.how === 'link' ? 'linked' : 'copied', `${change.target}${moved}`)
    }
    case 'skipped':
      return line('skipped', `${change.target}  (it already existed)`)
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
      return line('removed', `${change.target}${backup}${leftover}`)
    }
    case 'kept': {
      const reason = {
        foreign: 'not deployed by configfile',
        modified: 'modified since it was copied',
        identical: 'not copied by configfile',
        'source-missing': 'its source was missing',
      }[change.reason]
      return line('kept', `${change.target}  (${reason})`)
    }
    case 'failed':
      return line(
        'failed',
        `${change.target ?? `module ${change.module ?? '?'}`}  ${change.reason}`,
      )
    case 'synced':
      return line(
        'synced',
        change.from === change.to
          ? `${change.folder}  (already up to date with ${change.upstream})`
          : `${change.folder}  with ${change.upstream} (${short(change.from)} → ${short(change.to)})`,
      )
    case 'saved-patch':
      return line('saved', `local changes to ${change.file}`)
    case 'script':
      return line('script', `${change.name}  exit ${change.exitCode}`)
    case 'cloned':
      return line('cloned', `${change.repository} into ${change.folder}`)
    case 'reused':
      return line('reused', `${change.folder} for ${change.repository}`)
    case 'configured':
      return line('saved', `configuration ${change.file}`)
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

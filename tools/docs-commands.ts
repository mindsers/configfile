// Generates the usage, arguments and options of each command in the commands
// reference (docs/src/content/docs/reference/commands.md) from the commands'
// own definitions, so that the page cannot drift from the code.
//
//   node tools/docs-commands.ts          updates the page
//   node tools/docs-commands.ts --check  fails if the page is out of date
//
// The page holds the prose; each command has a block between
//   <!-- generated: configfile modules deploy -->
//   <!-- /generated -->
// which this script fills. A new command needs its block added by hand first.
// tests/docs.test.ts makes the same comparison as --check.

import { readFileSync, writeFileSync } from 'node:fs'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import type { Command } from 'commander'

import type { Context } from '../src/context.ts'
import { History } from '../src/history.ts'
import { Output } from '../src/output.ts'
import { buildProgram } from '../src/program.ts'
import { nonInteractivePrompts } from '../src/prompts.ts'

export const COMMANDS_PAGE = fileURLToPath(
  new URL('../docs/src/content/docs/reference/commands.md', import.meta.url),
)

const MARKER = /<!--\s*(\/)?generated\s*(?::\s*(.*?))?\s*-->/g

interface Block {
  name: string
  /** Offsets of the opening marker's end and of the closing marker's start. */
  contentStart: number
  contentEnd: number
}

/** The page with every generated block rewritten from the commands' definitions. */
export function renderCommandsPage(page: string): string {
  const commands = new Map(listCommands(buildProgram(inertContext())).map(c => [path(c), c]))
  const blocks = findBlocks(page)

  const problems: string[] = []
  const names = blocks.map(block => block.name)
  for (const name of commands.keys()) {
    if (!names.includes(name)) problems.push(`"${name}" has no <!-- generated: ${name} --> block.`)
  }
  for (const [index, name] of names.entries()) {
    if (!commands.has(name)) problems.push(`"${name}" is not a command.`)
    else if (names.indexOf(name) !== index) problems.push(`"${name}" has more than one block.`)
  }
  for (const command of commands.values()) problems.push(...undocumented(command))
  if (problems.length > 0) throw new Error(problems.join('\n'))

  // The page's own line endings, so that a CRLF checkout stays as it is.
  const eol = page.includes('\r\n') ? '\r\n' : '\n'
  let result = ''
  let offset = 0
  for (const block of blocks) {
    const generated = describe(commands.get(block.name) as Command).replaceAll('\n', eol)
    result += page.slice(offset, block.contentStart) + eol + generated
    offset = block.contentEnd
  }
  return result + page.slice(offset)
}

/** The generated blocks of the page, in order; throws on a malformed marker. */
function findBlocks(page: string): Block[] {
  const blocks: Block[] = []
  let open: { name: string; end: number } | null = null

  for (const match of page.matchAll(MARKER)) {
    const [marker, closing, rawName] = match
    const start = match.index
    if (closing == null) {
      const name = (rawName ?? '').trim()
      if (name === '') throw new Error(`A <!-- generated --> marker names no command.`)
      if (open != null) throw new Error(`The block of "${open.name}" has no <!-- /generated -->.`)
      open = { name, end: start + marker.length }
    } else {
      if (open == null) throw new Error('A <!-- /generated --> marker closes no block.')
      blocks.push({ name: open.name, contentStart: open.end, contentEnd: start })
      open = null
    }
  }
  if (open != null) throw new Error(`The block of "${open.name}" has no <!-- /generated -->.`)
  return blocks
}

/** Every command users run, nested ones included, but not their groups or `help`. */
function listCommands(program: Command): Command[] {
  return program.commands.flatMap(command =>
    command.commands.length > 0 ? listCommands(command) : [command],
  )
}

function path(command: Command): string {
  const names: string[] = []
  for (let current: Command | null = command; current != null; current = current.parent) {
    names.unshift(current.name())
  }
  return names.join(' ')
}

/** Arguments and options without a description, which the page could not explain. */
function undocumented(command: Command): string[] {
  return [
    ...command.registeredArguments
      .filter(arg => arg.description.trim() === '')
      .map(arg => `Argument "${arg.name()}" of "${path(command)}" has no description.`),
    ...command.options
      .filter(option => option.description.trim() === '')
      .map(option => `Option "${option.flags}" of "${path(command)}" has no description.`),
  ]
}

function describe(command: Command): string {
  const help = command.createHelp()
  // All arguments, documented or not: commander's visibleArguments hides them all
  // when none has a description.
  const args = command.registeredArguments
  // --help is shown once for all commands, in the page's introduction.
  const options = help.visibleOptions(command).filter(option => option.long !== '--help')

  // As --help prints it, without the alias ("deploy|d") and without
  // "[options]" when --help is the only option.
  const alias = command.aliases()[0]
  let usage = help.commandUsage(command)
  if (alias != null) usage = usage.replace(`${command.name()}|${alias}`, command.name())
  if (options.length === 0) usage = usage.replace(' [options]', '')
  const lines = ['```sh', usage, '```', '']

  const short = shortForm(command)
  if (short != null) lines.push(`Short form: \`${short}\`.`, '')

  const rows = [
    ...args.map(arg => [help.argumentTerm(arg), help.argumentDescription(arg)]),
    ...options.map(option => [help.optionTerm(option), help.optionDescription(option)]),
  ]
  if (rows.length > 0) {
    lines.push('| Argument or option | Description |', '| --- | --- |')
    for (const [term = '', description = ''] of rows) {
      lines.push(`| \`${cell(term)}\` | ${cell(description)} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** `configfile m d` for `configfile modules deploy`, or null without aliases. */
function shortForm(command: Command): string | null {
  const names: string[] = []
  let aliased = false
  for (let current: Command | null = command; current != null; current = current.parent) {
    const alias = current.parent == null ? undefined : current.aliases()[0]
    if (alias != null) aliased = true
    names.unshift(alias ?? current.name())
  }
  return aliased ? names.join(' ') : null
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** A context for building the program only: nothing is read, written or asked. */
function inertContext(): Context {
  const sink = new Writable({ write: (_chunk, _encoding, done) => done() })
  return {
    home: '/nonexistent',
    cwd: '/nonexistent',
    platform: 'linux',
    output: new Output(sink, sink),
    prompts: nonInteractivePrompts,
    history: new History('/nonexistent'),
  }
}

if (import.meta.main) {
  const page = readFileSync(COMMANDS_PAGE, 'utf8')
  const rendered = renderCommandsPage(page)
  if (rendered === page) {
    console.log(`${COMMANDS_PAGE} is up to date.`)
  } else if (process.argv.includes('--check')) {
    console.error(`${COMMANDS_PAGE} is out of date: run "pnpm docs:commands".`)
    process.exit(1)
  } else {
    writeFileSync(COMMANDS_PAGE, rendered)
    console.log(`Updated ${COMMANDS_PAGE}.`)
  }
}

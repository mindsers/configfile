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
// which this script fills. tests/docs.test.ts runs the check.

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

const BLOCK = /<!-- generated: (.+?) -->\n[\s\S]*?<!-- \/generated -->/g

/** The page with every generated block rewritten from the commands' definitions. */
export function renderCommandsPage(page: string): string {
  const commands = new Map(listCommands(buildProgram(inertContext())).map(c => [path(c), c]))

  const documented = [...page.matchAll(BLOCK)].map(match => match[1] ?? '')
  const missing = [...commands.keys()].filter(name => !documented.includes(name))
  const unknown = documented.filter(name => !commands.has(name))
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      [
        ...missing.map(name => `"${name}" has no <!-- generated: ${name} --> block.`),
        ...unknown.map(name => `"${name}" is not a command.`),
      ].join('\n'),
    )
  }

  return page.replace(BLOCK, (_, name: string) => {
    const command = commands.get(name) as Command
    return `<!-- generated: ${name} -->\n${describe(command)}<!-- /generated -->`
  })
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

function describe(command: Command): string {
  const help = command.createHelp()
  // "configfile modules deploy|d [options] [modules...]", without the alias.
  const usage = help.commandUsage(command).replace(/\|\S+/g, '')
  const lines = ['```sh', usage, '```', '']

  const aliases = aliasesOf(command)
  if (aliases != null) lines.push(`Short form: \`${aliases}\`.`, '')

  const args = help.visibleArguments(command)
  const options = help.visibleOptions(command).filter(option => option.long !== '--help')
  const rows = [
    ...args.map(arg => [help.argumentTerm(arg), help.argumentDescription(arg)]),
    ...options.map(option => [help.optionTerm(option), help.optionDescription(option)]),
  ]
  if (rows.length > 0) {
    lines.push('| Argument or option | Description |', '| --- | --- |')
    for (const [term, description] of rows) {
      lines.push(`| \`${term}\` | ${cell(description ?? '')} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** `configfile m d` for `configfile modules deploy`, or null without aliases. */
function aliasesOf(command: Command): string | null {
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
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const page = readFileSync(COMMANDS_PAGE, 'utf8')
  const rendered = renderCommandsPage(page)
  if (process.argv.includes('--check')) {
    if (rendered !== page) {
      console.error(`${COMMANDS_PAGE} is out of date: run "pnpm docs:commands".`)
      process.exit(1)
    }
  } else if (rendered !== page) {
    writeFileSync(COMMANDS_PAGE, rendered)
    console.log(`Updated ${COMMANDS_PAGE}.`)
  }
}

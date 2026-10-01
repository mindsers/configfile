#!/usr/bin/env node
import os from 'node:os'

import { History } from './history.ts'
import { Output } from './output.ts'
import { main } from './program.ts'
import { interactivePrompts, nonInteractivePrompts } from './prompts.ts'

const home = os.homedir()

process.exitCode = await main(process.argv.slice(2), {
  home,
  cwd: process.cwd(),
  output: new Output(process.stdout, process.stderr),
  prompts: process.stdin.isTTY ? interactivePrompts : nonInteractivePrompts,
  history: new History(home),
})

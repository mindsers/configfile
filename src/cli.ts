#!/usr/bin/env node
import os from 'node:os'

import { History } from './history.js'
import { Output } from './output.js'
import { main } from './program.js'
import { interactivePrompts, nonInteractivePrompts } from './prompts.js'

const home = os.homedir()

process.exitCode = await main(process.argv.slice(2), {
  home,
  cwd: process.cwd(),
  output: new Output(process.stdout, process.stderr),
  prompts: process.stdin.isTTY ? interactivePrompts : nonInteractivePrompts,
  history: new History(home),
})

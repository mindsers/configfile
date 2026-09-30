#!/usr/bin/env node
import os from 'node:os'

import { Output } from './output.js'
import { main } from './program.js'
import { interactivePrompts, nonInteractivePrompts } from './prompts.js'

process.exitCode = await main(process.argv.slice(2), {
  home: os.homedir(),
  cwd: process.cwd(),
  output: new Output(process.stdout, process.stderr),
  prompts: process.stdin.isTTY ? interactivePrompts : nonInteractivePrompts,
})

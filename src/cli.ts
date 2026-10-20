#!/usr/bin/env node
import os from 'node:os'

import { History } from './history.ts'
import { Output } from './output.ts'
import { main } from './program.ts'
import { interactivePrompts, nonInteractivePrompts } from './prompts.ts'

const home = os.homedir()

// No top-level await: the standalone binaries run this file as CommonJS.
let settled = false
void main(process.argv.slice(2), {
  home,
  cwd: process.cwd(),
  platform: process.platform,
  output: new Output(process.stdout, process.stderr),
  prompts: process.stdin.isTTY ? interactivePrompts : nonInteractivePrompts,
  history: new History(home),
}).then(
  code => {
    settled = true
    process.exitCode = code
  },
  error => {
    settled = true
    throw error
  },
)
// As a top-level await that never settles: a run that stops halfway is not a success.
process.on('exit', () => {
  if (!settled) process.exitCode = 13
})

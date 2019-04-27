import test, { beforeEach, afterEach } from 'ava'
import fs from 'fs'
import path from 'path'
import rimraf from 'rimraf'

import { ExecService } from '../../../src/services/exec.service'
import { ScriptNotExist } from '../../../src/services/exec'

const tmpData = path.join(__dirname, './env-file')

let execService
let settingsService

beforeEach('init temp files for tests', t => {
  fs.mkdirSync(tmpData)
  fs.mkdirSync(path.join(tmpData, 'scripts'))
  fs.mkdirSync(path.join(tmpData, 'files'))

  fs.writeFileSync(path.join(tmpData, 'scripts/test1.sh'), '')
  fs.writeFileSync(path.join(tmpData, 'scripts/test2.js'), '')
  fs.writeFileSync(path.join(tmpData, 'scripts/test3'), '')
  fs.writeFileSync(path.join(tmpData, 'scripts/"tEsts 28.js"'), '')

  fs.mkdirSync(path.join(tmpData, 'files/module1'))
  fs.mkdirSync(path.join(tmpData, 'files/"module 2"'))
  fs.mkdirSync(path.join(tmpData, 'files/badmodule'))
  fs.writeFileSync(path.join(tmpData, 'files/"moDule 2"/settings.json'), '{"files":[{"source_path":"","target_path":""}]}')
  fs.writeFileSync(path.join(tmpData, 'files/module1/settings.json'), '{"files":[]}')
})

beforeEach('init service', t => {
  settingsService = {
    folderPath: tmpData,
    scriptExtension: ['.sh']
  }
  execService = new ExecService(settingsService)
})

afterEach.always('clean temp files', t => {
  rimraf.sync(tmpData)
})

test(`.runScript should throw ScriptNotExist when script name is invalid`, t => {
  t.plan(1)

  return execService.runScript('zdjkqh')
    .then(() => {
      t.fail('Execution must failed when script name is invalid.')
    })
    .catch(e => {
      t.true(e instanceof ScriptNotExist)
    })
})

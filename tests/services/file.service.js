import test, { beforeEach, afterEach } from 'ava'
import fs from 'fs'
import path from 'path'
import rimraf from 'rimraf'

import { FileService } from '../../src/services/file.service'

const tmpData = path.join(__dirname, './env-file')

let fileService
let configService

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
  configService = {
    folderPath: tmpData,
    scriptExtension: ['.sh']
  }
  fileService = new FileService(configService)
})

afterEach.always('clean temp files', t => {
  rimraf.sync(tmpData)
})

test('.scripts should return name and path of valid scripts', t => {
  t.deepEqual(fileService.scripts.map(el => el.script), ['test1'])
  t.is(fileService.scripts.filter(el => ('path' in el)).length, 1)

  configService.scriptExtension = ['.js', '.sh', '.flg']
  t.deepEqual(fileService.scripts.map(el => el.script), ['tests-28', 'test1', 'test2'])
  t.is(fileService.scripts.filter(el => ('path' in el)).length, 3)
})

test('.modules should return name and path of valid modules', t => {
  t.deepEqual(fileService.modules.map(el => el.module), ['module-2', 'module1'])
  t.is(fileService.modules.filter(el => ('path' in el)).length, 2)
})

test('.modules should return target and source of each file in modules', t => {
  const modules = fileService.modules

  t.plan(modules.reduce((length, module) => { length += module.files.length; return length }, 0))

  for (const module of modules) {
    for (const file of module.files) {
      t.is(('target' in file) && ('source' in file), true)
    }
  }
})

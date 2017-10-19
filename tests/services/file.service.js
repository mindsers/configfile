import test, { beforeEach, afterEach } from 'ava'
import fs from 'fs'
import path from 'path'
import rimraf from 'rimraf'

import { FileService } from '../../src/services/file'

const tmpData = path.join(__dirname, './env-file')

let fileService
let configService

beforeEach('init temp files for tests', t => {
  fs.mkdirSync(tmpData)
  fs.mkdirSync(path.join(tmpData, 'scripts'))
  fs.mkdirSync(path.join(tmpData, 'files'))
  fs.writeFileSync(path.join(tmpData, 'scripts/test1.sh'), '')
  fs.writeFileSync(path.join(tmpData, 'scripts/test2.js'), '')
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

test('FileService#scripts should return name and path of valid scripts', t => {
  t.deepEqual(fileService.scripts.map(el => el.script), ['test1'])

  configService.scriptExtension = ['.js', '.sh', '.flg']
  t.deepEqual(fileService.scripts.map(el => el.script), ['test1', 'test2'])
})

test.todo('FileService#modules should return name and path of valid modules')
test.todo('FileService#modules should return target and source of each file in modules')
test.todo('FileService#runScript should call chmod')
test.todo('FileService#runScript should call execFile')
test.todo(`FileService#runScript should rethrows BadScriptPermission when 'EACCESS' error is thrown`)

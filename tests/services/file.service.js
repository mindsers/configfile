import test, { beforeEach, afterEach } from 'ava'
import { stub } from 'sinon'

import { FileService } from '../../src/services/file'

let fileService
let configService
beforeEach('init service', t => {
  configService = stub({
    get folderPath() { return false },
    get scriptExtension() { return false }
  })
  fileService = new FileService(configService)
})

afterEach('restore spies', t => {
  configService.restore()
})

test.todo('FileService#scripts should return name and path of valid script')
test.todo('FileService#modules should return name and path of valid modules')
test.todo('FileService#modules should return target and source of each file in modules')
test.todo('FileService#runScript should call chmod')
test.todo('FileService#runScript should call execFile')
test.todo(`FileService#runScript should rethrows BadScriptPermission when 'EACCESS' error is thrown`)

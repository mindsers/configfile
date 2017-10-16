import test, { beforeEach, afterEach } from 'ava'
import fs from 'fs'
import path from 'path'
import rimraf from 'rimraf'

import { ConfigService, ConfigurationFileNotExist } from '../../src/services/config'

const tmpData = path.join(__dirname, './data')
let configService

beforeEach('init temp files for tests', t => {
  fs.mkdirSync(tmpData)
})

beforeEach('init service', t => {
  configService = new ConfigService(path.join(tmpData, 'configfile'))
})

afterEach.always('clean temp files', t => {
  rimraf.sync(tmpData)
})

test('ConfigService#configFileExist should return false when main configuration file does not exist', t => {
  t.false(configService.configFileExist())
})

test('ConfigService#configFileExist should return true when main configuration file exist', t => {
  fs.writeFileSync(configService.configPath, JSON.stringify({}))
  t.true(configService.configFileExist())
})

test('ConfigService#configData should return good data when main configuration file exist', t => {
  fs.writeFileSync(configService.configPath, JSON.stringify({ 'repo_url': 'https://', 'folder_path': './' }))
  t.deepEqual(configService.configData(), { 'folder_path': './', 'repo_url': 'https://' })
})

test('ConfigService#configData should throw an error when main configuration file exist', t => {
  t.throws(() => configService.configData(), ConfigurationFileNotExist)
})

test.todo('ConfigService#scriptExtension should return default value when it is not specified in file')
test.todo('ConfigService#scriptExtension should return existing value')
test.todo('ConfigService#scriptExtension should check is an array before update')
test.todo('ConfigService#folderPath should return existing value')
test.todo('ConfigService#folderPath should update value')
test.todo('ConfigService#repoUrl should return existing value')
test.todo('ConfigService#repoUrl should update value')

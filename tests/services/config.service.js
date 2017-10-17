import test, { beforeEach, afterEach } from 'ava'
import fs from 'fs'
import path from 'path'
import rimraf from 'rimraf'
import { spy } from 'sinon'

import { ConfigService, ConfigurationFileNotExist } from '../../src/services/config'
import { FsUtils } from '../../src/shared/utils'

const tmpData = path.join(__dirname, './env-config')
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

test('ConfigService#scriptExtension should return default value when it is not specified in file', t => {
  fs.writeFileSync(configService.configPath, JSON.stringify({}))
  t.deepEqual(configService.scriptExtension, ['.js', '.sh', ''])
})

test('ConfigService#scriptExtension should return existing value', t => {
  fs.writeFileSync(configService.configPath, JSON.stringify({ 'script_extensions': ['.sh', '.vb'] }))
  t.deepEqual(configService.scriptExtension, ['.sh', '.vb'])
})

test('ConfigService#scriptExtension should check is an array before update', t => {
  fs.writeFileSync(configService.configPath, JSON.stringify({}))

  spy(Array, 'isArray')

  configService.scriptExtension = 3
  t.not(configService.scriptExtension, 3)
  t.true(Array.isArray.calledOnce)

  configService.scriptExtension = ['.ts']
  t.deepEqual(configService.scriptExtension, ['.ts'])

  Array.isArray.restore()
})

test('ConfigService#folderPath should return existing value', t => {
  fs.writeFileSync(configService.configPath, JSON.stringify({ 'folder_path': './test' }))
  t.is(configService.folderPath, './test')
})

test('ConfigService#folderPath should update value', t => {
  fs.writeFileSync(configService.configPath, JSON.stringify({ 'folder_path': './test' }))
  configService.folderPath = './coucou'

  const data = JSON.parse(fs.readFileSync(configService.configPath))
  t.is(data['folder_path'], './coucou')
})

test('ConfigService#repoUrl should return existing value', t => {
  fs.writeFileSync(configService.configPath, JSON.stringify({ 'repo_url': 'http://github.com' }))
  t.is(configService.repoUrl, 'http://github.com')
})

test('ConfigService#repoUrl should update value', t => {
  fs.writeFileSync(configService.configPath, JSON.stringify({ 'repo_url': 'http://github.com' }))
  configService.repoUrl = 'http://google.com'

  const data = JSON.parse(fs.readFileSync(configService.configPath))
  t.is(data['repo_url'], 'http://google.com')
})

test('ConfigService#getConfig should return the value for the given key', t => {
  fs.writeFileSync(configService.configPath, JSON.stringify({ 'key': 'value' }))
  t.is(configService.getConfig('key'), 'value')
})

test('ConfigService#getConfig should return null when the given key does not exist', t => {
  fs.writeFileSync(configService.configPath, JSON.stringify({ 'notkey': 'value' }))
  t.is(configService.getConfig('key'), null)
})

test('ConfigService#setConfig should update value in file', t => {
  fs.writeFileSync(configService.configPath, JSON.stringify({ 'notkey': 'value' }))
  configService.setConfig('notkey', 'notvalue')

  const data = JSON.parse(fs.readFileSync(configService.configPath))
  t.is(data['notkey'], 'notvalue')
})

test('ConfigService#setConfig should create file if not exist', t => {
  if (!FsUtils.fileExist(configService.configPath)) {
    configService.setConfig('key', 'krakow')

    const data = JSON.parse(fs.readFileSync(configService.configPath))
    t.is(data['key'], 'krakow')

    return
  }

  t.fail(`File ${configService.configPath} should not exist.`)
})

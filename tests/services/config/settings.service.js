import test, { beforeEach, afterEach } from 'ava'
import fs from 'fs'
import path from 'path'
import rimraf from 'rimraf'
import { spy } from 'sinon'

import { SettingsService, ConfigurationFileNotExist } from '../../../src/services'
import { FsUtils } from '../../../src/shared/utils'

const tmpData = path.join(__dirname, './env-config')
let settingsService

beforeEach('init temp files for tests', t => {
  fs.mkdirSync(tmpData)
})

beforeEach('init service', t => {
  settingsService = new SettingsService(path.join(tmpData, 'configfile'))
})

afterEach.always('clean temp files', t => {
  rimraf.sync(tmpData)
})

test('.configFileExist should return false when main configuration file does not exist', t => {
  t.false(settingsService.configFileExist())
})

test('.configFileExist should return true when main configuration file exist', t => {
  fs.writeFileSync(settingsService.configPath, JSON.stringify({}))
  t.true(settingsService.configFileExist())
})

test('.configData should return good data when main configuration file exist', t => {
  fs.writeFileSync(settingsService.configPath, JSON.stringify({ 'repo_url': 'https://', 'folder_path': './' }))
  t.deepEqual(settingsService.configData(), { 'folder_path': './', 'repo_url': 'https://' })
})

test('.configData should throw an error when main configuration file exist', t => {
  t.throws(() => settingsService.configData(), ConfigurationFileNotExist)
})

test('.scriptExtension should return default value when it is not specified in file', t => {
  fs.writeFileSync(settingsService.configPath, JSON.stringify({}))
  t.deepEqual(settingsService.scriptExtension, ['.js', '.sh', ''])
})

test('.scriptExtension should return existing value', t => {
  fs.writeFileSync(settingsService.configPath, JSON.stringify({ 'script_extensions': ['.sh', '.vb'] }))
  t.deepEqual(settingsService.scriptExtension, ['.sh', '.vb'])
})

test('.scriptExtension should check is an array before update', t => {
  fs.writeFileSync(settingsService.configPath, JSON.stringify({}))

  spy(Array, 'isArray')

  settingsService.scriptExtension = 3
  t.not(settingsService.scriptExtension, 3)
  t.true(Array.isArray.calledOnce)

  settingsService.scriptExtension = ['.ts']
  t.deepEqual(settingsService.scriptExtension, ['.ts'])

  Array.isArray.restore()
})

test('.folderPath should return existing value', t => {
  fs.writeFileSync(settingsService.configPath, JSON.stringify({ 'folder_path': './test' }))
  t.is(settingsService.folderPath, './test')
})

test('.folderPath should update value', t => {
  fs.writeFileSync(settingsService.configPath, JSON.stringify({ 'folder_path': './test' }))
  settingsService.folderPath = './coucou'

  const data = JSON.parse(fs.readFileSync(settingsService.configPath))
  t.is(data['folder_path'], './coucou')
})

test('.repoUrl should return existing value', t => {
  fs.writeFileSync(settingsService.configPath, JSON.stringify({ 'repo_url': 'http://github.com' }))
  t.is(settingsService.repoUrl, 'http://github.com')
})

test('.repoUrl should update value', t => {
  fs.writeFileSync(settingsService.configPath, JSON.stringify({ 'repo_url': 'http://github.com' }))
  settingsService.repoUrl = 'http://google.com'

  const data = JSON.parse(fs.readFileSync(settingsService.configPath))
  t.is(data['repo_url'], 'http://google.com')
})

test('.getConfig should return the value for the given key', t => {
  fs.writeFileSync(settingsService.configPath, JSON.stringify({ 'key': 'value' }))
  t.is(settingsService.getConfig('key'), 'value')
})

test('.getConfig should return null when the given key does not exist', t => {
  fs.writeFileSync(settingsService.configPath, JSON.stringify({ 'notkey': 'value' }))
  t.is(settingsService.getConfig('key'), null)
})

test('.setConfig should update value in file', t => {
  fs.writeFileSync(settingsService.configPath, JSON.stringify({ 'notkey': 'value' }))
  settingsService.setConfig('notkey', 'notvalue')

  const data = JSON.parse(fs.readFileSync(settingsService.configPath))
  t.is(data['notkey'], 'notvalue')
})

test('.setConfig should create file if not exist', t => {
  if (!FsUtils.fileExist(settingsService.configPath)) {
    settingsService.setConfig('key', 'krakow')

    const data = JSON.parse(fs.readFileSync(settingsService.configPath))
    t.is(data['key'], 'krakow')

    return
  }

  t.fail(`File ${settingsService.configPath} should not exist.`)
})

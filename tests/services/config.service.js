import test, { beforeEach, afterEach } from 'ava'
import fs from 'fs'
import path from 'path'
import rimraf from 'rimraf'

import { ConfigService, ConfigurationFileNotExist } from '../../src/services/config'

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

  configService.scriptExtension = 3
  t.not(configService.scriptExtension, 3)

  configService.scriptExtension = ['.ts']
  t.deepEqual(configService.scriptExtension, ['.ts'])
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

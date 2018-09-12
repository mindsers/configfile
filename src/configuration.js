const fs = require('fs')
const path = require('path')

const { InjectorService, DeployService, ExecService, FileService, ConfigService } = require('./services')

const packageData = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json')))
const optionsFilePath = packageData.config.optionsFilePath.replace('~', process.env.HOME)

const injector = InjectorService.getMainInstance()

injector.provide(DeployService)
injector.provide(ExecService)
injector.provide(FileService, [ConfigService])
injector.provide(ConfigService, [{ useValue: optionsFilePath }])

module.exports = exports = {
  package: packageData
}

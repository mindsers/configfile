const fs = require('fs')
const path = require('path')

export function getPackageData() {
  const filePath = path.join(__dirname, '../../../package.json')
  const file = fs.readFileSync(filePath)

  return JSON.parse(file)
}

export function getOptionsFilePath() {
  const pkg = getPackageData()

  return pkg.config.optionsFilePath.replace('~', process.env.HOME)
}

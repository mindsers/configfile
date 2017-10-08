class BadScriptPermission extends Error {
  constructor(scriptName) {
    super(`Bad permission on "${scriptName}" script.`)

    this.scriptName = scriptName
  }
}

module.exports = exports = { BadScriptPermission }

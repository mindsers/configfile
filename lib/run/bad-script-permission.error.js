class BadScriptPermission extends Error {
  constructor(scriptName, message = `Bad permission on "${scriptName}" script.`) {
    super(message)

    this.scriptName = scriptName
  }
}

module.exports = exports = { BadScriptPermission }

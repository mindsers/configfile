class ScriptNotExist extends Error {
  constructor(scriptName, message = `Script "${scriptName}" doesn't exist.`) {
    super(message)

    this.scriptName = scriptName
  }
}

module.exports = exports = { ScriptNotExist }

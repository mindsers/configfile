class ScriptNotExist extends Error {
  constructor(scriptName) {
    super(`Script "${scriptName}" doesn't exist.`)

    this.scriptName = scriptName
  }
}

module.exports = exports = { ScriptNotExist }

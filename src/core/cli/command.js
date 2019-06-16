class Command {
  get alias() {
    return null
  }

  get commandName() {
    return null
  }

  get description() {
    return ''
  }

  get options() {
    return []
  }

  // optional run() method which contains the action logic
}

module.exports = { Command }

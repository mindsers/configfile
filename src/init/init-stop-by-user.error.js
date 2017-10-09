class InitStopedByUser extends Error {
  constructor(message = 'User stop the init phase.') {
    super(message)
  }
}

module.exports = exports = { InitStopedByUser }

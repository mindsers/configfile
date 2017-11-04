class DeployStopedByUser extends Error {
  constructor(message = 'User stop the deployment phase.') {
    super(message)
  }
}

module.exports = exports = { DeployStopedByUser }

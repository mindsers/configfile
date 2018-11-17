export class InitStopedByUser extends Error {
  constructor(message = 'User stop the init phase.') {
    super(message)
  }
}

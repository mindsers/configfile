class MethodDoesNotExist extends Error {
  constructor(useClass, methodName) {
    super(`${methodName} does not exist in class ${useClass}`)
  }
}

module.exports = exports = {
  MethodDoesNotExist
}

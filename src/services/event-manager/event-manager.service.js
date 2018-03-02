const { MethodDoesNotExist } = require('./method-not-exist.error')

class EventManagerService {
  constructor() {
    this.observers = []
  }

  register(eventName, instance, methodName = 'subcribe') {
    if (instance[methodName] == null) {
      throw new MethodDoesNotExist(instance.constructor.name, methodName)
    }

    this.observers.push({
      eventName,
      instance,
      methodName
    })
  }

  emit(eventName, data) {
    this.observers
      .filter(observer => observer.eventName === eventName)
      .forEach(({ instance, methodName }) => {
        instance[methodName](data)
      })
  }
}

module.exports = exports = {
  EventManagerService
}

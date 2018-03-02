class InjectorService {
  constructor() {
    this.data = []
  }

  static getMainInstance() {
    const previousInstance = InjectorService.instances.find(instance => instance instanceof InjectorService)

    if (previousInstance != null) {
      return previousInstance
    }

    InjectorService.instances.push(new InjectorService())

    return InjectorService.getMainInstance()
  }

  provide(useClass, params = []) {
    const alreadyExist = this.data
      .filter(service => service.useClass === useClass)
      .length > 0

    if (alreadyExist) {
      return
    }

    this.data.push({
      useClass,
      params: params.map(param => {
        if (param.useValue != null || param.useClass != null) {
          return param
        }

        return {
          useClass: param
        }
      })
    })
  }

  get(useClass) {
    const previousInstance = InjectorService.instances.find(instance => instance instanceof useClass)

    if (previousInstance != null) {
      return previousInstance
    }

    const data = this.data.find(data => data.useClass === useClass)

    if (data != null) {
      const Class = data.useClass
      const instance = new Class(...data.params.map(param => {
        if (param.useClass != null) {
          return this.get(param.useClass)
        }

        return param.useValue
      }))

      InjectorService.instances.push(instance)

      return instance
    }

    return null
  }
}

InjectorService.instances = []

module.exports = exports = { InjectorService }

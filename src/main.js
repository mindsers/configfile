import { TermApplication } from './core/term-application'
import { ScriptsListCommand } from './commands/scripts-list.command'
import { FileService } from './services/file.service'

(() => {
  const app = TermApplication.createInstance()

  app.register(ScriptsListCommand, [FileService])

  app.provide(FileService)

  app.start()
})()

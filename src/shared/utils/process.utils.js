import { spawn } from 'child_process'

export class ProcessUtils {
  static spawn(filename) {
    return new Promise((resolve, reject) => {
      const child = spawn(filename, [], { stdio: 'inherit' })

      child.addListener('error', reject)
      child.addListener('exit', resolve)
    })
  }
}

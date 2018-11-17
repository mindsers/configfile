import childProcess from 'child_process'

export class ProcessUtils {
  static execFile(filename) {
    const child = childProcess.spawn(filename, [], { stdio: 'inherit' })

    return {
      stdout: child.stdout,
      stderr: child.stderr,
      toPromise: () => new Promise((resolve, reject) => {
        child.addListener('error', reject)
        child.addListener('exit', resolve)
      })
    }
  }
}

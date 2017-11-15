const childProcess = require('child_process')

class ProcessUtils {
  static execFile(filename) {
    const child = childProcess.execFile(filename)

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

module.exports = exports = { ProcessUtils }

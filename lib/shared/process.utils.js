const child_process = require('child_process')

class ProcessUtils {
  static execFile(filename) {
    const child = child_process.execFile(filename)

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

const git = require('gift')

class GitUtils {
  static clone(repoUrl, repoPath) {
    return new Promise((resolve, reject) => {
      git.clone(repoUrl, repoPath, (error, repo) => {
        if (error != null) {
          reject(error)
          return
        }

        resolve(repo)
      })
    })
  }
}

module.exports = exports = {
  GitUtils
}

const git = require('gift')

const URL_REGEX = /(?:git|ssh|https?|git@[-\w.]+):(\/\/)?(.*?)(\.git)(\/?|#[-\d\w._]+?)$/

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

  static isGitUrl(text) {
    return URL_REGEX.test(text)
  }
}

module.exports = exports = {
  GitUtils
}

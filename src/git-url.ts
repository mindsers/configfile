import { existsSync } from 'node:fs'

import { redactUrl } from './output.ts'
import { resolveUserPath } from './paths.ts'

/** Schemes git can clone from (see "GIT URLS" in `git help clone`). */
const SCHEMES = new Set([
  'ssh',
  'git',
  'http',
  'https',
  'ftp',
  'ftps',
  'file',
  'git+ssh',
  'ssh+git',
])

/**
 * Checks a repository URL as git reads it, and returns it ready to save:
 *
 * - `scheme://[user@]host[:port]/path`, for the schemes git supports;
 * - `[user@]host:path`, the scp-like syntax of SSH (no slash before the colon);
 * - `transport::address`, handled by a git remote helper;
 * - otherwise a local path, which must exist. It is returned absolute (`~` is
 *   the home folder), so the saved URL does not depend on the current folder.
 *
 * Returns a message saying what is wrong instead when git could not use it.
 */
export function checkRepositoryUrl(
  input: string,
  where: { home: string; cwd: string },
): { url: string } | { error: string } {
  const url = input.trim()
  // Messages name the URL: its credentials must not show (or reach the history).
  const shown = redactUrl(url)

  if (url === '') return { error: 'A repository URL is required.' }
  // git would read it as an option, even where configfile passes it after "--".
  if (url.startsWith('-')) return { error: `"${shown}" is not a repository URL.` }

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase()
  if (scheme != null) {
    if (!SCHEMES.has(scheme)) {
      return { error: `"${scheme}://" is not a protocol git can clone from.` }
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { error: `"${shown}" is not a valid URL.` }
    }
    if (scheme !== 'file' && parsed.hostname === '') {
      return { error: `"${shown}" has no host name.` }
    }
    if (parsed.pathname === '' || parsed.pathname === '/') {
      return { error: `"${shown}" does not name a repository (the path is missing).` }
    }
    return { url }
  }

  if (/^[A-Za-z0-9][A-Za-z0-9+.-]*::./.test(url)) return { url }

  // scp-like: as for git, only when no slash comes before the first colon.
  const colon = url.indexOf(':')
  const slash = url.indexOf('/')
  if (colon > 0 && (slash === -1 || colon < slash)) {
    const host = url.slice(0, colon).replace(/^[^@]*@/, '')
    if (host === '' || /\s/.test(host)) return { error: `"${shown}" has no valid host name.` }
    if (colon === url.length - 1) {
      return { error: `"${shown}" does not name a repository (nothing after ":").` }
    }
    return { url }
  }

  const local = resolveUserPath(url, where)
  if (!existsSync(local)) {
    return {
      error:
        `"${shown}" is neither a URL (such as https://github.com/me/dotfiles.git or ` +
        `git@github.com:me/dotfiles.git) nor an existing folder.`,
    }
  }
  return { url: local }
}

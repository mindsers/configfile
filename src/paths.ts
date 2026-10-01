import path from 'node:path'

/** Expands a leading `~` to `home`, then resolves the result against `cwd`. */
export function resolveUserPath(
  input: string,
  { home, cwd }: { home: string; cwd: string },
): string {
  const expanded = input === '~' || input.startsWith('~/') ? path.join(home, input.slice(1)) : input

  return path.resolve(cwd, expanded)
}

/** Turns a file or folder name into a command-line friendly identifier. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/ /g, '-')
    .replace(/[^\w-]+/g, '')
}

/** Whether `child` is `parent` or inside it (paths are compared as text). */
export function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Where configfile keeps its own files. Deployments must never touch them. */
export function configfilePaths(home: string): {
  /** The configuration. */
  rc: string
  /** configfile's working folder: lock, record, mirror, saved changes. */
  dir: string
  /** Default location of the mirror of the dotfiles repository. */
  dotfiles: string
  /** Local changes found in the mirror, saved before syncing. */
  saved: string
} {
  const dir = path.join(home, '.configfile')
  return {
    rc: path.join(home, '.configfilerc'),
    dir,
    dotfiles: path.join(dir, 'dotfiles'),
    saved: path.join(dir, 'saved'),
  }
}

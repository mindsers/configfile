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

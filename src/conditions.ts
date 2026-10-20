/**
 * `"when"`: the machines a module or an entry is for. Every condition lives
 * under this key, and one configfile does not know makes the module or entry
 * invalid: ignoring it would deploy the files everywhere.
 */
export interface Condition {
  /** The systems it is for (`macos`, `linux`): any of them. */
  readonly os?: readonly string[]
  /**
   * The profiles it is for: a machine needs one of each list (an entry's
   * condition and its module's each give one).
   */
  readonly profiles?: readonly (readonly string[])[]
}

/** What conditions are checked against: this machine, or the one a preview asks for. */
export interface Machine {
  /** As scripts name it: `macos`, `linux`. */
  readonly os: string
  readonly profiles: readonly string[]
}

/** The systems a condition can name: those configfile runs on. */
export const SYSTEMS = ['macos', 'linux'] as const

const KEYS = ['os', 'profiles'] as const

/** A profile name: letters, digits, `.`, `_` and `-`, starting with a letter or a digit. */
export function isProfileName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

/** Reads a `"when"` value. Returns why it cannot be used instead. */
export function readWhen(value: unknown): Condition | { invalid: string } {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { invalid: '"when" must be an object, such as { "os": "macos" }' }
  }
  const fields = value as Record<string, unknown>
  const unknown = Object.keys(fields).filter(key => !(KEYS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    return {
      invalid:
        `"when" has ${unknown.map(key => `"${key}"`).join(', ')}, which configfile doesn't ` +
        'know (use "os" and "profiles")',
    }
  }
  if (Object.keys(fields).length === 0) {
    return { invalid: '"when" is empty (use "os" and "profiles")' }
  }

  const condition: { os?: string[]; profiles?: string[][] } = {}
  if (fields.os !== undefined) {
    const os = listOf(fields.os)
    if (os == null || !os.every(name => (SYSTEMS as readonly string[]).includes(name))) {
      return {
        invalid: `"when.os" must be ${SYSTEMS.map(name => `"${name}"`).join(' or ')}, or a list of them`,
      }
    }
    condition.os = [...new Set(os)]
  }
  if (fields.profiles !== undefined) {
    const profiles = listOf(fields.profiles)
    if (profiles == null || !profiles.every(isProfileName)) {
      return {
        invalid:
          '"when.profiles" must be a profile name (letters, digits, ".", "_" and "-"), ' +
          'or a list of them',
      }
    }
    condition.profiles = [[...new Set(profiles)]]
  }
  return condition
}

/** A string, or a non-empty list of strings. */
function listOf(value: unknown): string[] | null {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value) || value.length === 0) return null
  return value.every(item => typeof item === 'string') ? value : null
}

/** Both conditions: an entry's with its module's. */
export function combine(a: Condition | null, b: Condition | null): Condition | null {
  if (a == null) return b
  if (b == null) return a
  const os = intersect(a.os, b.os)
  const profiles = [...(a.profiles ?? []), ...(b.profiles ?? [])]
  return { ...(os != null && { os }), ...(profiles.length > 0 && { profiles }) }
}

function intersect(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): readonly string[] | undefined {
  if (a == null) return b
  if (b == null) return a
  return a.filter(item => b.includes(item))
}

/** Why a machine is not one the condition is for, or `null` when it is. */
export function whyNotFor(condition: Condition | null, machine: Machine): string | null {
  if (condition == null) return null
  if (condition.os != null && !condition.os.includes(machine.os)) {
    // A module and its entry for different systems.
    if (condition.os.length === 0) return 'for no system: the module and the entry name others'
    return `for ${alternatives(condition.os)}; this machine: ${machine.os}`
  }
  for (const profiles of condition.profiles ?? []) {
    if (profiles.some(profile => machine.profiles.includes(profile))) continue
    const mine =
      machine.profiles.length === 0
        ? 'this machine has no profile'
        : `this machine: ${machine.profiles.map(name => `"${name}"`).join(', ')}`
    return `for profile ${alternatives(profiles.map(name => `"${name}"`))}; ${mine}`
  }
  return null
}

/** `when` as words: `macos, profile "work"`. */
export function describeWhen(condition: Condition): string {
  const parts: string[] = []
  if (condition.os != null) parts.push(alternatives(condition.os))
  for (const profiles of condition.profiles ?? []) {
    parts.push(`profile ${alternatives(profiles.map(name => `"${name}"`))}`)
  }
  return parts.join(', ')
}

/** The profiles a condition names. */
export function profilesOf(condition: Condition | null): string[] {
  return condition?.profiles?.flat() ?? []
}

/** `macos or linux`. */
function alternatives(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`
}

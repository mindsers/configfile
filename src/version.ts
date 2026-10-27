import { readFileSync } from 'node:fs'

/** Set by tools/build-binary.ts: a standalone binary has no package.json to read. */
declare const CONFIGFILE_VERSION: string | undefined

/** The version of configfile that runs. */
export const version: string =
  typeof CONFIGFILE_VERSION === 'string'
    ? CONFIGFILE_VERSION
    : (
        JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
          version: string
        }
      ).version

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Builds dist/ once so the end-to-end tests run the real CLI. */
export default function setup(): void {
  const tsc = fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url))
  execFileSync(tsc, ['-p', 'tsconfig.build.json'], { stdio: 'inherit' })
}

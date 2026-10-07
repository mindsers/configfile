# How to contribute to configfile

*First off, thanks for taking the time to contribute!*

This file is a set of guidelines for contributing to *configfile*. These are mostly guidelines, not rules. Use your best judgment, and feel free to propose changes to this document in a pull request.

Everyone taking part in the project follows the [code of conduct](CODE_OF_CONDUCT.md).

#### Table of contents

[How can I contribute?](#how-can-i-contribute)

* [Do you have a question?](#do-you-have-a-question)
* [Did you find a bug?](#did-you-find-a-bug)
* [Did you find a security vulnerability?](#did-you-find-a-security-vulnerability)
* [Did you write a patch that fixes a bug?](#did-you-write-a-patch-that-fixes-a-bug)
* [Did you fix whitespace, format code, or make a purely cosmetic patch?](#did-you-fix-whitespace-format-code-or-make-a-purely-cosmetic-patch)
* [Do you intend to add a new feature or change an existing one?](#do-you-intend-to-add-a-new-feature-or-change-an-existing-one)
* [Do you want to contribute to the documentation?](#do-you-want-to-contribute-to-the-documentation)

[Styleguides](#styleguides)

* [Development setup](#development-setup)
* [Branches and pull requests](#branches-and-pull-requests)
* [TypeScript styleguide](#typescript-styleguide)
* [Git commit messages](#git-commit-messages)

## How can I contribute?

### Do you have a question?

* **Search the [issues][Issues] first**: it may already be answered.

* Otherwise, [open an issue with the question template][new-issue]. Include your *configfile* version (`configfile --version`), the command you ran and what you expected.

### Did you find a bug?

* **Ensure the bug was not already reported** by searching on GitHub under [Issues][Issues].

* If you're unable to find an open issue addressing the problem, [open a new one with the bug report template][new-issue]. Be sure to include a **title and clear description**, your *configfile*, Node.js and operating system versions, the command you ran, and its output.

* `configfile history` shows what *configfile* changed and why runs failed: its output often helps. Check it for paths or names you would rather not share before pasting it.

### Did you find a security vulnerability?

* **Do not open a public issue.** Follow the [security policy](SECURITY.md) to report it privately.

### Did you write a patch that fixes a bug?

* Write new unit test(s) that match the bug case to limit future regression.

* Open a new GitHub pull request with the patch (see [Branches and pull requests](#branches-and-pull-requests)).

* Ensure the PR description clearly describes the problem and solution. Include the relevant issue number if applicable.

* Before submitting, please ensure your code follows the code conventions.

### Did you fix whitespace, format code, or make a purely cosmetic patch?

* Your changes must follow the coding conventions.

* Please ensure that your changes do not include regressions.

### Do you intend to add a new feature or change an existing one?

* Please ask first ([open an issue][Issues]) before embarking on any significant pull request (e.g. implementing features, refactoring code), otherwise you risk spending a lot of time working on something that the project's developers might not want to merge into the project.

* Please adhere to the coding conventions used in this project (indentation, accurate comments, etc.) and any other requirements (such as test coverage, documentation).

### Do you want to contribute to the documentation?

The documentation lives with the source code: the [README](README.md) for users, and this file for contributors.

* Please refer to the "Do you intend to add a new feature or change an existing one?" section.

## Styleguides

### Development setup

*Configfile* is written in TypeScript and uses [pnpm](https://pnpm.io). Tool versions (Node.js, pnpm, and the workflow linters) are pinned in `mise.toml`: with [mise](https://mise.jdx.dev), run `mise install` once in the repository. Node.js 24.11 or later is supported.

```bash
pnpm install
pnpm check            # lint, type check and tests
pnpm test:watch       # tests in watch mode
pnpm test:coverage    # tests with coverage (CI fails below the thresholds in vitest.config.ts)
pnpm dev --help       # run the TypeScript source directly
pnpm build            # compile to dist/
node dist/cli.js --help
```

`pnpm-workspace.yaml` protects installs: a newly published version is only installed after a day, a version with weaker provenance than earlier ones is refused, and no dependency may run install scripts. So `pnpm update` or `pnpm add` cannot pick a version published in the last 24 hours (`ERR_PNPM_NO_MATCHING_VERSION`): wait, or pick an older version.

### Branches and pull requests

The project uses [git-flow](https://nvie.com/posts/a-successful-git-branching-model/): `develop` holds the next release, and `master` the released versions.

* Create your branch from `develop`: `feature/<name>` for a feature or a documentation change, `bugfix/<name>` for a fix.

* Open the pull request against `develop`, never `master`. Releases are handled by the maintainer: a version tag pushed on `master` publishes the package as a GitHub release, with a build provenance attestation, and to npm when it is turned on (`.github/workflows/publish.yml`).

* Describe the change for a reviewer who doesn't know the code: why it is needed, what changes for users, how to test it. The pull request template has the sections.

* Add a line to the `[Unreleased]` section of the [CHANGELOG](CHANGELOG.md) when users will notice the change. Write it for users, in the style of the existing entries.

* `pnpm check` must pass: it is what the CI runs.

### TypeScript styleguide

Formatting and linting are handled by [Biome](https://biomejs.dev), configured in `biome.json`. Run `pnpm format` before committing; `pnpm lint` must pass.

* Relative imports use the `.ts` extension (`import { x } from './x.ts'`), so Node.js runs the source directly; the build rewrites them to `.js`. Only erasable TypeScript syntax is allowed (no `enum`, `namespace` or constructor parameter properties).
* Wrapping an error keeps it as the `cause` (`new CliError(message, { cause: error })`): `DEBUG=1` shows it.
* Expected failures throw a `CliError` (exit code and message for the user); never call `process.exit`.
* Commands get everything from the injected `Context` (home, cwd, output, prompts, history) so they can be tested. The only exception is the `DEBUG` environment variable, read where stack traces are printed.
* Bug fixes come with a test that reproduces the bug.

### Git commit messages

Commit messages and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```txt
<type>[optional scope][!]: <description>

[optional body]

[optional footer(s)]
```

* Use one of these types: `feat` (a new feature), `fix` (a bug fix), `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore` or `revert`.

* The scope is optional and names the part of the project: `feat(modules): add status command`, `docs(changelog): …`.

* Mark breaking changes with `!` after the type or scope (`feat!: …`), and explain them in a `BREAKING CHANGE:` footer.

* Write the description in the imperative mood and present tense, starting with a lowercase letter and without a final period ("add feature", not "Added feature."). Keep the first line to 72 characters or less.

* Reference issues and pull requests in the body or the footer (`Fixes #48`).

[Issues]: https://github.com/mindsers/configfile/issues
[new-issue]: https://github.com/mindsers/configfile/issues/new/choose

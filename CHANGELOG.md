# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Changed
- **Breaking:** global files are copied into the home folder instead of linked, unless their
  entry sets `"method": "link"`. configfile records the repository's version each copy holds:
  `update` and `modules deploy` update a copy when the repository changed it and nothing
  changed it on this machine, keep the files changed on this machine (by you, or by a tool
  that writes its own configuration), and report the files changed on both sides. For those,
  `modules deploy` asks whether to replace them (yours moved to `.old`); without a terminal it
  keeps them and fails, and `--force` replaces them. In a copied folder, the files a tool
  creates are never touched. `update` never moves a file aside, asks a question or runs a
  module's scripts. Comparing copies needs git: when it fails, nothing is changed and the
  command says why. `modules deploy` turns the links made by 1.x into copies of what they
  showed; see
  [Upgrading from 1.x](https://docs.configfile.sh/guides/upgrading-from-1/)
  ([#297](https://github.com/mindsers/configfile/issues/297)).
- **Breaking:** `modules status` says `copied` or `linked` for global files instead of
  `deployed`, and `modules deploy` says `(copied)` or `(linked)`. `--force` on `modules deploy`
  also replaces the global copies changed on this machine.
- **Breaking:** `modules status` exits with 1, after showing every file, when some of them
  cannot be checked.
- `update` only saves the local changes that the remote doesn't have: a change already pushed
  from a working copy no longer leaves a patch and a warning. The warning names the files the
  patch changes, and suggests `git -C <your working copy> apply --3way <patch>`, which lets you
  review the changes before committing them, instead of `git am`. The patch is now written byte
  for byte, so files that are not UTF-8 text are saved as they are
  ([#297](https://github.com/mindsers/configfile/issues/297)).
- The install script is at `https://configfile.sh/install.sh`:
  `curl -fsSL https://configfile.sh/install.sh | sh`. The address given with 1.1.0,
  `https://docs.configfile.sh/install.sh`, keeps working.
### Removed
- **Breaking:** the `"global": true | false` key of an entry, deprecated since 1.0: use
  `"deploy": "global" | "local"`. An entry that still has it is invalid.
- **Breaking:** the configfile 0.3 format of `settings.json`, a plain list, deprecated since 1.0:
  put the list in a `"files"` key. A module that still uses it cannot be used. The JSON Schema
  no longer accepts either.
### Added
- Modules and their files can be for some machines only, with `"when": { "os": "macos",
  "profiles": "work" }` in `settings.json`. A machine's profiles are `"profiles"` in
  `~/.configfilerc`, set by `init --profile` or by `init`'s question. `modules deploy` skips
  what is not for this machine, scripts included, and still succeeds; `modules status` says why,
  and warns about a profile no module uses. `--os` and `--profile` on `modules status` and
  `modules deploy --dry-run` preview another machine. Files no longer for this machine are
  reported by `status` and `update`, and removed by `modules undeploy --removed`. Scripts get
  `CONFIGFILE_PROFILES`, and `modules adopt --os/--profile` writes the condition. An unknown
  condition makes the module or entry invalid; configfile 1.x ignores `when`
  ([#302](https://github.com/mindsers/configfile/issues/302)).
- `configfile modules adopt <path…> --module <name>` adds files or folders of this machine to a
  module: in your own working copy (given with `--into`, then remembered as `"working_copy"`),
  it copies them into the module, adds their entries to its `settings.json`, commits, pushes,
  syncs, and keeps the files in place as configfile's copies. It refuses a working copy with
  uncommitted changes, and brings one that is behind up to date. `--no-push` stops after the
  commit ([#296](https://github.com/mindsers/configfile/issues/296)).
- With a working copy configured (`init --working-copy`, or the first `modules adopt`), `update`
  pushes its commits before syncing, then keeps as configfile's copies the files that the
  commits of its branch brought by the sync added, when they are already the repository's
  version
  ([#296](https://github.com/mindsers/configfile/issues/296)).
- `modules status` says whether a file in the way of a global file is identical to the
  repository's version, and shows a link that a file replaced (a tool that saves by renaming a
  new file over it) as `linked, but a file replaced the link`. `modules deploy` asks before
  putting the link back; without a terminal it keeps the file and fails, and `--force` puts the
  link back, moving the file to `.old` ([#296](https://github.com/mindsers/configfile/issues/296)).
- The `"method"` setting of an entry: `"copy"` (the default for global files) or `"link"`.
  `modules status` lists the files of a copy that changed on this machine, in the repository, or
  on both sides ([#297](https://github.com/mindsers/configfile/issues/297)).
- `modules status` lists, under each deployed link, the changes made through it in configfile's
  copy of the repository: files changed or deleted through the link, and new files a tool
  created in a linked folder. The next `update` saves them in a patch, then puts the
  repository's version back and removes the new files
  ([#297](https://github.com/mindsers/configfile/issues/297)).
- Standalone binaries for macOS (13.5 or later) and Linux (GNU C library 2.28 or later), on x64
  and arm64, with each release, and an install script:
  `curl -fsSL https://docs.configfile.sh/install.sh | sh` installs configfile on a new machine
  without Node.js or a package manager ([#301](https://github.com/mindsers/configfile/issues/301)).
- Scripts get the repository folder, their name and the system in the `CONFIGFILE_REPO`,
  `CONFIGFILE_SCRIPT` and `CONFIGFILE_OS` environment variables
  ([#295](https://github.com/mindsers/configfile/issues/295)).
- A JSON Schema for `settings.json`, at `https://docs.configfile.sh/schemas/settings.json`: with
  `"$schema"` at the top of the file, editors complete and check it as you type.
- A documentation site, [docs.configfile.sh](https://docs.configfile.sh), with a tutorial, guides,
  a reference and explanations. The README is now a short introduction that links to it.
- Modules can name scripts to run when they are deployed or undeployed, with `"pre_deploy"`,
  `"post_deploy"`, `"pre_undeploy"` and `"post_undeploy"` in `settings.json`. A script that fails
  stops the command there, unless `--keep-going` is given, and a `pre_` script that fails leaves
  the files of its module as they are; `--no-hooks` runs none. A name that matches no script
  fails the command before anything is changed. `modules status` shows the scripts
  ([#298](https://github.com/mindsers/configfile/issues/298)).

### Changed
- `modules deploy` and `modules undeploy` work on one module at a time, taking the lock for each
  module in turn instead of the whole run. When a local file already exists, the question to
  replace it is asked once the other files of its module are deployed, no longer at the very end.

### Fixed
- `update` and `init` take the lock that `modules deploy` and `undeploy` use, so files are never
  deployed while a sync or a new configuration replaces them: each waits for the other, and says
  so ([#313](https://github.com/mindsers/configfile/issues/313)).
- Two configfile commands started together could both take over the lock of a process that no
  longer exists, and change files at the same time. The lock is now created with its owner's pid
  already in it (where the filesystem supports hard links), and taken over by one process at a
  time. A lock that cannot be read, or that holds no process number, is no longer taken over.
- A lock that cannot be removed at the end of a command no longer hides the command's result: a
  warning says to delete it. A lock replaced or removed by someone else while a command held it is
  reported too.
- When `~/.configfile` or its lock file cannot be created, written or read, the commands that take
  the lock (`init`, `update`, `modules deploy` and `undeploy`) say that the lock cannot be taken,
  and why, instead of reporting an unexpected error or waiting.
- When more than one settings entry failed, `modules deploy` and `undeploy` reported "settings
  entrys" instead of "settings entries".

## [1.0.0] - 2026-10-05
### Added
- The `modules undeploy` command to remove the files configfile deployed and restore the saved
  versions it made (recorded in `~/.configfile/`).
- The `modules status` command to see which files are deployed.
- `modules undeploy --removed` to remove the files deployed for entries that left the repository
  and restore what they replaced (`--all` does it too); `modules status` lists these files and
  `update` warns about them.
- The `update` command to sync with the latest version of the dotfiles repository.
- A preview of the changes with `--dry-run` on `modules deploy` and `modules undeploy`.
- Options to use configfile in scripts without questions: `--repo`, `--folder` and `--force`
  on `init`, `--all` and `--force` on `modules deploy`, `--all` on `modules undeploy`.
- The `deploy` setting in `settings.json` to choose how a file is deployed: `"global"`, `"local"`
  or `"none"` to keep a file in the repository without deploying it.
- Arguments can be passed to scripts: `configfile scripts run <name> -- <arguments>`.
- A script can be a folder containing an `index` file.
- A script can have a version for macOS or Linux (`setup.macos.sh`, `setup.linux.sh`), used instead
  of the generic one (`setup.sh`) on that system. In 0.3.1, `setup.macos.sh` was simply another
  `setup` script.
- A history of what configfile changed, when, and whether it failed, in
  `~/.configfile/history.jsonl`, and the `history` command to see it
  ([#36](https://github.com/mindsers/configfile/issues/36)).
- The `settings.json` format is documented in the README.
- Releases are published as GitHub releases: the package tarball, its `SHA256SUMS`, and a build
  provenance attestation that `gh attestation verify` checks.
- configfile can be installed with Homebrew (`brew install mindsers/tap/configfile`), which also
  installs Node.js and git, or with npm from the release tarball.
- `init` and `update` say how to install git when it is missing, or Apple's command line
  developer tools on macOS, before cloning or syncing (`init` checks before asking for the URL).

### Changed
- **Breaking:** Node.js 24.11 or later is required, and only macOS and Linux are supported.
- **Breaking:** a relative `target_path` of a global file now starts from the home folder instead
  of the current folder.
- The `global` setting in `settings.json` is deprecated. Use `deploy` instead; `global` will be
  removed in 2.0.
- Configfile is rewritten in TypeScript ([!281](https://github.com/mindsers/configfile/pull/281)).
- Commands exit with an error code when something fails, so configfile can be used in scripts.
- With `DEBUG=1`, an error also shows the system error behind it.
- Files replaced by `modules deploy --local` are saved as `.old` files, like global files.
- Configfile no longer makes scripts executable: scripts that are not executable run with the
  interpreter of their first line (`#!`), or with `node` or `sh` for `.js` and `.sh` files.
- Deploying refuses targets inside the dotfiles repository or the module, targets containing
  them, and configfile's own files, whatever the path used to reach them.
- A `source_path` must stay inside its module folder.
- With `script_extensions`, a file is a script only when its extension is one of the list (`""`
  means no extension). 0.3.1 kept any file whose name contained one of them.
- `modules deploy` and `modules undeploy` fail on a module name that does not exist, instead of
  doing nothing.
- Local copies follow symbolic links: a copy never points into the repository.
- `settings.json` files written for configfile 0.3.1 (a plain list) are deprecated; put the list
  in a `"files"` key.
- `~/.configfilerc` is only readable by its owner, since the repository URL may contain credentials.
  A file other users can read, such as one written by 0.3.1, is made private when configfile
  reads it, with a warning.
- `init` reuses a folder that already contains the repository.
- `init` only asks for the repository URL and clones it into `~/.configfile/dotfiles`, a copy
  configfile keeps in sync; `--folder` chooses another location.
- `update` makes configfile's copy identical to the remote, so it never fails on conflicts or
  unpushed work; local changes found in the copy are first saved as a patch in
  `~/.configfile/saved/`.

### Fixed
- `init` accepts every repository URL git accepts, such as `https://github.com/me/dotfiles.git`, which
  0.3.1 refused ([#48](https://github.com/mindsers/configfile/issues/48)). It still refuses the ones
  git cannot clone from, and asks again in a terminal: a URL without a repository path, an unknown
  protocol, or a local folder that does not exist. A local folder is saved as an absolute path.
- Script standard outputs are correctly displayed ([!57](https://github.com/mindsers/configfile/pull/57), [#13](https://github.com/mindsers/configfile/issues/13))
- A failed `init` saved the configuration anyway.
- Deploying a module could overwrite a previously saved `.old` file.
- Hidden files such as `.DS_Store` were listed as scripts.
- Stopping configfile while a script runs (for example with `kill`) could leave the script
  running.
- Scripts could not read input from the terminal.
- Two configfile processes running at the same time could lose files.

## [0.3.1] - 2018-08-05
### Fixed
- Fix module data collection.

## [0.3.0] - 2017-11-15
### Added
- A contribution guide (CONTRIBUTING.md) to help new contributors.
- The local deployment of configuration file. (`-l` on `modules deploy`).

### Changed
- Adopte a git like command style: `configfile run` => `configfile scritps run`.
- Create a "saved version" if preexisting file exist when user deploy a module.
- Do not indentify the modules to deploy cause the deployment of all available modules. User authorization is required.

## [0.2.1] - 2017-10-13
### Fixed
- Replace the JS error message (non-handled error) on `scripts` and `modules` commands
  by a user friendly error message.

## [0.2.0] - 2017-10-12
### Added
- This CHANGELOG file to hopefully serve to all developers and users.
- The `scripts` command to list all custom scripts available.
- Tha `modules` command to list all custom modules available.

### Changed
- The project design was reviewed. Now we use services to provide data to all commands.
- A better error handling with `try...catch` and custom error classes.
- New name for the main configuration file is now `.configfilerc`. Other files is stored
  inside of `.configfile` folder.

## [0.1.1] - 2017-09-25
### Changed
- The project adopt a new name: **configfile** instead of **configfiles**.
  **configfiles** is already reserved on npm.

## [0.1.0] - 2017-09-25
### Added
- The `init` command to initialize configuration files in the user session.
- The `deploy` command to deploy modules of custom and saved configuration files.
- The `run` command to run custom and saved scripts. Scripts can be write in all languages.
- The README file to give first information on the project (installation, usage, etc.).

[Unreleased]: https://github.com/mindsers/configfile/compare/1.0.0...HEAD
[1.0.0]: https://github.com/mindsers/configfile/tree/1.0.0
[0.3.1]: https://github.com/mindsers/configfile/tree/0.3.1
[0.3.0]: https://github.com/mindsers/configfile/tree/0.3.0
[0.2.1]: https://github.com/mindsers/configfile/tree/0.2.1
[0.2.0]: https://github.com/mindsers/configfile/tree/0.2.0
[0.1.1]: https://github.com/mindsers/configfile/tree/0.1.1
[0.1.0]: https://github.com/mindsers/configfile/tree/0.1.0

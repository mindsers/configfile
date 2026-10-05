# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Releases are published to npm with a provenance statement, which `npm audit signatures` checks.
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
- Git URL verification in `init` command is less strict. ([#48](https://github.com/mindsers/configfile/issues/48))
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

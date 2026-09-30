# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [Unreleased]
Compared to 0.3.1.

### Added
- Add new contributor to SPONSORS.md
- Non-interactive use, for scripts and provisioning:
  - `init --repo <url> --folder <path>` (plus `--force` when a configuration already exists);
  - `modules deploy --all` deploys every module and `--force` replaces existing local files
    without asking;
  - when stdin is not a terminal, a command that needs an answer fails and names the option to use.
- `modules undeploy` removes deployed files and restores their `.old` backups; anything configfile
  did not deploy, and local copies modified since, are kept.
- `modules deploy --dry-run` / `modules undeploy --dry-run` show what would be done.
- `modules status` shows whether each file is deployed.
- `configfile update` pulls the dotfiles repository.
- `init` reuses a folder that already contains a git repository instead of failing.
- `scripts run <name> -- [args...]` passes arguments to the script.
- `"deploy": "global" | "local" | "none"` in `settings.json` (`"global": true | false` still works).
  `"none"` keeps a file in the repository without deploying it.
- `modules deploy` warns about files that define no deployment strategy (they are still not deployed).
- Local deployment (`modules deploy --local`) can copy folders.
- Scripts can be written in any language: non-executable scripts are run with the interpreter of
  their shebang line.
- Warnings for invalid `settings.json` entries, duplicate module or script names and broken
  symbolic links, with the reason.
- The `settings.json` format is documented in the README.

### Changed
- **Breaking:** Node.js 22.13 or later is required, and only macOS and Linux are supported.
- **Breaking:** a relative `target_path` of a global file is relative to the home folder instead of
  the current folder.
- **Deprecated:** `"global": true | false` in `settings.json` prints a warning; use
  `"deploy": "global" | "local"`. It will be removed in 2.0.
- Rewritten in TypeScript, as a native ES module, with no runtime dependency other than
  commander and @inquirer/prompts.
- Commands exit with a non-zero code on failure; `scripts run` exits with the script's code
  (128 + signal number when the script is killed). Errors and warnings are written to stderr,
  and so are the messages of `scripts run`, so that stdout only contains the script's output.
- `configfile modules` and `configfile scripts` list modules and scripts.
- A local copy identical to the source is reported as up to date instead of asking to replace it.
- Scripts are no longer `chmod`-ed before running, so the dotfiles repository is not modified.
- When a local file is replaced, the existing one is moved to `<target>.old` (or `.old.1`, …)
  instead of being overwritten; a folder is replaced instead of merged.
- When a global file's target is a symbolic link to something else, it is moved to `.old` and
  the file is deployed, instead of printing a warning.
- A module whose `settings.json` cannot be read is listed as ignored, and deploying it fails.
- A `target_path` that would replace the home folder, the current folder or one of their parents
  (such as `""`, `"~"` or `"."`) is refused.
- `folder_path` in `~/.configfilerc` may start with `~`. `script_extensions` may omit the dot
  (`"py"`), and an invalid value is reported instead of being ignored.
- The repository URL and folder path given to `init` are no longer checked with a regex
  (paths with digits and URLs without `.git` are accepted); git reports invalid URLs.
  ([#48](https://github.com/Mindsers/configfile/issues/48))
- The `~/.configfile` folder is no longer created.

### Fixed
- Local deployment (`--local`) stopped at the first existing file, never asked to overwrite it,
  and reported success.
- Unknown modules given to `modules deploy` were silently ignored.
- A failed `init` (non-empty folder, failed clone) still saved the configuration.
- Backing up an existing file overwrote an earlier `.old` backup.
- Running an unknown script, or `scripts run` / `modules deploy <names>` before `init`, crashed
  with a stack trace.
- Files with a non-allowed extension and hidden files (such as `.DS_Store`) were listed as scripts.
- Pressing Ctrl+C during `scripts run` could leave the script running in the background.
- Script standard outputs are correctly displayed ([!57](https://github.com/Mindsers/configfile/pull/57), [#13](https://github.com/Mindsers/configfile/issues/13))

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

## 0.1.0 - 2017-09-25
### Added
- The `init` command to initialize configuration files in the user session.
- The `deploy` command to deploy modules of custom and saved configuration files.
- The `run` command to run custom and saved scripts. Scripts can be write in all languages.
- The README file to give first information on the project (installation, usage, etc.).

[Unreleased]: https://github.com/Mindsers/configfile/tree/develop
[0.3.1]: https://github.com/Mindsers/configfile/tree/0.3.1
[0.3.0]: https://github.com/Mindsers/configfile/tree/0.3.0
[0.2.1]: https://github.com/Mindsers/configfile/tree/0.2.1
[0.2.0]: https://github.com/Mindsers/configfile/tree/0.2.0
[0.1.1]: https://github.com/Mindsers/configfile/tree/0.1.1
[0.1.0]: https://github.com/Mindsers/configfile/tree/0.1.0

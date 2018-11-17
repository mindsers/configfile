# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Add new contrubitor to SPONSORS.md
- Configfile will emit log to make debug easier ([!57](https://github.com/Mindsers/configfile/pull/57))

### Changed
- Use [Yabf](https://github.com/Mindsers/yabf) as base to build the next configfile.

### Fixed
- Git URL verification in `init` command is less strict. ([#48](https://github.com/Mindsers/configfile/issues/48))

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

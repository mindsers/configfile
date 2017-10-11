# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2017-10-12
### Added
- This CHANGELOG file to hopefully serve to all developers and users.
- The `scripts` command to list all custom scripts available.
- Tha `modules` command to list all custom modules available.

## Changed
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
[0.2.0]: https://github.com/Mindsers/configfile/tree/0.2.0
[0.1.1]: https://github.com/Mindsers/configfile/tree/0.1.1
[0.1.0]: https://github.com/Mindsers/configfile/tree/0.1.0

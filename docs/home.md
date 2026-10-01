# Configfile

Configfile is a command line application that helps developers manage their development setup from a dotfiles git repository.

## Getting Started

To install Configfile:

```bash
npm install --global configfile
```

macOS or Linux, Node.js 24.11 or later and git are required.

Generating first configuration:

```bash
configfile init
```

It asks for your repository URL and clones it into `~/.configfile/dotfiles`, a copy configfile keeps in sync with the remote (edit your dotfiles in your own working copy). To set it up without questions (in a script, for example):

```bash
configfile init --repo git@github.com:me/dotfiles.git
```

### Running the tests

```bash
pnpm install
pnpm check   # lint, type check and tests
```

See [How to contribute](../CONTRIBUTING.md) for the development setup.

### Additional commands

- [configfile modules list](../README.md#usage)
- [configfile modules status](../README.md#usage)
- [configfile modules deploy](../README.md#usage)
- [configfile modules undeploy](../README.md#usage)
- [configfile scripts list](../README.md#usage)
- [configfile scripts run](../README.md#usage)
- [configfile update](../README.md#usage)
- [configfile history](../README.md#history)

## Configfiles Configuration

- [Data folder structure](../README.md#data-storage)
- [Module settings](../README.md#modules)
- [Scripts](../README.md#scripts)
- [~/.configfilerc](../README.md#configuration)
- [History](../README.md#history)

## Project

- [How to contribute](../CONTRIBUTING.md)
- [Code of conduct](../CODE_OF_CONDUCT.md)
- [Security policy](../SECURITY.md)
- [Changelog](../CHANGELOG.md)
- [Support configfile on GitHub Sponsors](https://github.com/sponsors/mindsers)

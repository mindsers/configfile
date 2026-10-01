# Configfile

Configfile is a command line application that helps developers manage their development setup from a dotfiles git repository.

## Getting Started

To install Configfile:

```bash
npm install --global configfile
```

macOS or Linux, Node.js 22.13 or later and git are required.

Generating first configuration:

```bash
configfile init
```

It asks for your repository URL and clones it into `~/.configfile/repository`, a copy configfile keeps in sync with the remote (edit your dotfiles in your own working copy). To set it up without questions (in a script, for example):

```bash
configfile init --repo git@github.com:me/dotfiles.git
```

### Running unit tests

```bash
pnpm install
pnpm test
```

### Additional commands

- [configfile modules list](../README.md#usage)
- [configfile modules status](../README.md#usage)
- [configfile modules deploy](../README.md#usage)
- [configfile modules undeploy](../README.md#usage)
- [configfile scripts list](../README.md#usage)
- [configfile scripts run](../README.md#usage)
- [configfile update](../README.md#usage)

## Configfiles Configuration

- [Data folder structure](../README.md#data-storage)
- [Module settings](../README.md#modules)
- [Scripts](../README.md#scripts)
- [~/.configfilerc](../README.md#configuration)

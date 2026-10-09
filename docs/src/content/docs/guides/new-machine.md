---
title: Set up a new machine
description: Bring your configuration to a new computer, by hand or with a bootstrap script.
sidebar:
  order: 1
---

This guide takes a machine from nothing to your configuration, using a dotfiles repository you already have. If you don't have one yet, start with [Your first dotfiles repository](/getting-started/tutorial/).

## 1. Install configfile

On macOS, install [Homebrew](https://brew.sh) first if it isn't there yet, then:

```sh
brew install mindsers/tap/configfile
```

Homebrew also installs Node.js and git. [Installation](/getting-started/installation/) lists the other ways.

## 2. Give the machine access to your repository

For a private repository, the machine needs your git credentials before *configfile* can clone it: add an SSH key to your git host, or sign in with its command line tool (`gh auth login` for GitHub). A public repository can be cloned with its `https://` URL without credentials.

Avoid putting a token in the repository URL: *configfile* saves the URL in `~/.configfilerc`, and warns when it contains credentials.

## 3. Connect configfile to the repository

```sh
configfile init
```

*configfile* asks for the repository's URL and clones it into `~/.configfile/dotfiles`.

## 4. Deploy your modules

See what would be deployed, and what is in the way:

```sh
configfile modules status
configfile modules deploy --all --dry-run
```

Then deploy every module:

```sh
configfile modules deploy --all
```

Files that already exist where yours go, such as the default `~/.zshrc` of a new machine, are moved aside to `.old`, so you can compare them or bring them back with `configfile modules undeploy`.

## 5. Run your setup script

If your repository has a setup script, for example to install your tools, run it:

```sh
configfile scripts run setup
```

With a version per system (`setup.macos.sh`, `setup.linux.sh`), *configfile* picks the one for this machine. See [Scripts](/reference/scripts/).

## 6. Copy local files into your projects

Local files, such as an `.editorconfig`, are copied into the current folder rather than linked. In each project that needs them:

```sh
cd ~/projects/my-project
configfile modules deploy --all --local
```

## Do it all with one script

To set up machines regularly, put the steps in a script. Without a terminal to ask questions in, *configfile* needs everything as options: `--repo` for `init`, and module names or `--all` for `modules deploy`. [Use configfile in scripts and CI](/guides/scripts-and-ci/) lists them.

```sh title="bootstrap.sh"
#!/bin/sh
set -e

brew install mindsers/tap/configfile
configfile init --repo git@github.com:me/dotfiles.git
configfile modules deploy --all
configfile scripts run setup
```

`set -e` stops the script at the first step that fails: *configfile* exits with a non-zero code when a command fails. On a machine that already has a configuration, `init` refuses to replace it without `--force`.

## Keep the machine in sync

When you push changes to your repository, bring them to the machine with:

```sh
configfile update
```

Linked files are up to date right away. Run `configfile modules deploy --all` again when you add files or modules, as `update` reminds you, and `configfile modules undeploy --removed` to remove what the repository no longer deploys, which `update` warns about.

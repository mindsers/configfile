---
title: Set up a new machine
description: Bring your configuration to a new computer, by hand or with a bootstrap script.
sidebar:
  order: 1
---

This guide takes a machine from nothing to your configuration, using a dotfiles repository you already have. If you don't have one yet, start with [Your first dotfiles repository](/getting-started/tutorial/).

## 1. Install configfile

On a new machine, install the standalone binary, which needs neither a package manager nor Node.js:

```sh
curl -fsSL https://configfile.sh/install.sh | sh
```

It installs `~/.local/bin/configfile`, and says how to add that folder to your `PATH` when it is not there. *configfile* also needs git: on macOS, `xcode-select --install` installs it. [Installation](/getting-started/installation/) lists the other ways, such as Homebrew.

## 2. Give the machine access to your repository

For a private repository, the machine needs your git credentials before *configfile* can clone it: add an SSH key to your git host, or sign in with its command line tool (`gh auth login` for GitHub). A public repository can be cloned with its `https://` URL without credentials.

Avoid putting a token in the repository URL: *configfile* saves the URL in `~/.configfilerc`, and warns when it contains credentials.

## 3. Connect configfile to the repository

```sh
configfile init
```

*configfile* asks for the repository's URL and clones it into `~/.configfile/dotfiles`. When the repository's modules name profiles ([`when`](/reference/modules/#deploy-on-some-machines-only)), it also asks for this machine's profiles, such as `work` (without a terminal, give them with `--profile`). When the repository names a [`post_init` script](/reference/modules/#run-scripts-after-update-and-init), it asks whether to run it.

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

Modules that [name a script to run when they are deployed](/guides/module-scripts/), for example to install plugins, run it at this step, and the dry run lists it. If one fails, the modules after it are not deployed: fix the cause and run the command again.

## 5. Run your setup script

If your repository has a setup script, for example to install your tools, run it:

```sh
configfile scripts run setup
```

With a version per system (`setup.macos.sh`, `setup.linux.sh`), *configfile* picks the one for this machine. See [Scripts](/reference/scripts/).

## 6. Copy local files into your projects

Local files, such as an `.editorconfig`, are copied into the current folder rather than your home folder. In each project that needs them:

```sh
cd ~/projects/my-project
configfile modules deploy --all --local
```

## Do it all with one script

To set up machines regularly, put the steps in a script. Without a terminal to ask questions in, *configfile* needs everything as options: `--repo` for `init`, and module names or `--all` for `modules deploy`. [Use configfile in scripts and CI](/guides/scripts-and-ci/) lists them.

```sh title="bootstrap.sh"
#!/bin/sh
set -e

# Downloaded first: in "curl ... | sh", set -e would not see a failed download.
curl -fsSL https://configfile.sh/install.sh -o /tmp/install-configfile.sh
sh /tmp/install-configfile.sh
export PATH="$HOME/.local/bin:$PATH"
configfile init --repo git@github.com:me/dotfiles.git --profile work
configfile modules deploy --all
configfile scripts run setup
```

`set -e` stops the script at the first step that fails: *configfile* exits with a non-zero code when a command fails. If your repository names a [`post_init` script](/reference/modules/#run-scripts-after-update-and-init), add `--hooks` to `init` to run it without a terminal, instead of running it by hand: it then runs before `modules deploy`, so it deploys the modules itself if it needs their files. On a machine that already has a configuration, `init` refuses to replace it without `--force`.

## Bring this machine's files into the repository

A machine often has configuration files that aren't in your repository yet. Add them to a module with:

```sh
configfile modules adopt ~/.zshrc ~/.config/starship --module shell --into ~/src/dotfiles
```

`~/src/dotfiles` is your own working copy of the repository: *configfile* copies the files into `files/shell/`, adds them to its `configfile.module.json`, commits and pushes, then keeps them in place as its copies. Your other machines get them with `update` and `modules deploy shell`. The working copy is remembered, so `--into` can be left out next time. Add `--dry-run` to see what it would do first.

## Keep the machine in sync

When you push changes to your repository, bring them to the machine with:

```sh
configfile update
```

It updates the global files the repository changed, and keeps those changed on this machine. Run `configfile modules deploy --all` again when you add files or modules, as `update` reminds you, and `configfile modules undeploy --removed` to remove what the repository no longer deploys, which `update` warns about.

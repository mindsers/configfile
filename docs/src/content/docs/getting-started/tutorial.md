---
title: Your first dotfiles repository
description: From an empty repository to a deployed configuration file and a setup script, in ten minutes.
sidebar:
  order: 2
---

This tutorial takes you from nothing to a working setup: a dotfiles repository with one configuration file and one setup script, deployed on your machine by *configfile*. It takes about ten minutes.

You need *configfile* [installed](/getting-started/installation/) and a GitHub account (any git hosting works the same way).

## 1. Create your dotfiles repository

*configfile* doesn't store your files: they live in a git repository that you own, usually called `dotfiles`.

Create an empty repository named `dotfiles` on GitHub: no README, no license, nothing in it. *configfile* fills it in the next step.

## 2. Connect configfile to the repository

```sh
configfile init --repo git@github.com:me/dotfiles.git
```

The repository is empty, so *configfile* offers to set it up, then asks where your **working copy** goes: your own clone of the repository, where you edit your dotfiles. Keep `~/dotfiles`:

```txt
 Info  Cloning git@github.com:me/dotfiles.git into ~/.configfile/dotfiles…
Cloning into '/Users/me/.configfile/dotfiles'...
warning: You appear to have cloned an empty repository.
✔ git@github.com:me/dotfiles.git is empty. Set up a new dotfiles repository in it? Yes
✔ Your working copy (the clone where you edit your dotfiles): ~/dotfiles
 Info  Cloning git@github.com:me/dotfiles.git into ~/dotfiles…
Cloning into '/Users/me/dotfiles'...
warning: You appear to have cloned an empty repository.
 Info  Set up a new dotfiles repository in ~/dotfiles, and pushed it to git@github.com:me/dotfiles.git.
 Info  Syncing ~/.configfile/dotfiles…
 Done  Synced with origin/main (3c9e2a1).
 Info  Edit your dotfiles in ~/dotfiles, push, then run "configfile update" on each machine; or add files of this machine with "configfile modules adopt".
 Done  configfile is ready. Configuration saved to ~/.configfilerc.
```

*configfile* committed a few files to start from in `~/dotfiles`, with your git name and email, and pushed them. It remembers `~/dotfiles` as your working copy. (Set your name and email in git first: *configfile* never commits with one git would guess.)

```txt
configfile.repository.json
README.md
files/
    example/
        configfile.module.json
        example.conf
scripts/
    hello.sh
```

It also keeps its own copy of the repository in `~/.configfile/dotfiles`, and deploys from it. You never edit that copy: you edit your working copy, push, and *configfile* follows. [How it works](/concepts/how-it-works/) explains why.

:::note
Your repository already has commits? Clone it as your working copy, then run `configfile init --repo git@github.com:me/dotfiles.git --working-copy ~/dotfiles`: `init` only connects to it, and remembers your working copy.
:::

## 3. Add a first module

A **module** is a folder of `files/` that groups the configuration of one tool; `files/example` shows one. Create one for zsh in your working copy, with the file you want on every machine:

```sh
cd ~/dotfiles
mkdir -p files/zsh
echo 'alias ll="ls -la"' > files/zsh/zshrc
```

Then tell *configfile* where this file goes, in the module's `configfile.module.json`:

```json title="files/zsh/configfile.module.json"
{
  "$schema": "https://docs.configfile.sh/schemas/module.json",
  "files": [
    { "source_path": "zshrc", "target_path": "~/.zshrc", "deploy": "global" }
  ]
}
```

`"deploy": "global"` means the file is copied into your home folder, and kept up to date with the repository. The `$schema` line lets your editor suggest the keys. The [modules reference](/reference/modules/) lists every option.

:::tip
`configfile modules adopt --module zsh ~/.zshrc` does all of this with the `~/.zshrc` you already have: it copies it into the module, commits, pushes and syncs, and your `~/.zshrc` becomes *configfile*'s copy, so step 5 has nothing left to deploy.
:::

## 4. Add a setup script

Scripts go in `scripts/`, next to the example `hello.sh`. They're handy for what files alone can't do, such as installing tools:

```sh title="scripts/setup.sh"
#!/bin/sh
echo "Setting up $CONFIGFILE_OS from $CONFIGFILE_REPO"
```

`CONFIGFILE_OS` and `CONFIGFILE_REPO` are set by *configfile* when it runs the script (see [Scripts](/reference/scripts/)).

Commit and push, then bring the changes to *configfile*'s copy:

```sh
git add .
git commit -m "First module"
git push
configfile update
```

```txt
 Info  Syncing ~/.configfile/dotfiles…
 Done  Synced with origin/main (d33b70e). Run "configfile modules deploy --all" for new files.
 Warn  ~/.zshrc is not the repository's version, so configfile left it as it is: "configfile modules deploy zsh" would move it to .old and copy the repository's version.
```

`update` never replaces a file of yours: the next step deploys the module.

## 5. Deploy the module

Check where things stand:

```sh
configfile modules status
```

```txt
example:
  no global file
zsh:
  ~/.zshrc (not deployed: a file is in the way (differs from the repository))
```

You probably already have a `~/.zshrc`. Preview what deploying would do, without changing anything:

```sh
configfile modules deploy zsh --dry-run
```

```txt
 Info  Dry run, nothing is changed. Deploying zsh would do:
- ~/.zshrc (would be copied, the existing file moved to ~/.zshrc.old)
 Done  Dry run finished.
```

Your current file is kept, as `~/.zshrc.old`. Deploy:

```sh
configfile modules deploy zsh
```

```txt
 Info  Deploying zsh…
- ~/.zshrc (copied, previous file moved to ~/.zshrc.old)
 Done  Deployment finished.
```

`~/.zshrc` is now a copy of the file in the repository, which *configfile* keeps up to date. If something changes it on this machine (you, or a tool that writes its own configuration), *configfile* keeps that change: `configfile modules status` shows it.

## 6. Run the setup script

```sh
configfile scripts run setup
```

```txt
 Info  Running "setup"…
Setting up macos from ~/.configfile/dotfiles
 Done  Script "setup" finished.
```

## 7. Change a file and sync

Edit the file in your working copy, then push, as for any git repository:

```sh
cd ~/dotfiles
echo 'alias gs="git status"' >> files/zsh/zshrc
git commit -am "Add gs alias"
git push
```

Then bring the change to this machine:

```sh
configfile update
```

```txt
 Info  Syncing ~/.configfile/dotfiles…
- ~/.zshrc (updated from the repository)
 Done  Synced with origin/main (117f764). Run "configfile modules deploy --all" for new files.
```

`update` updated your copy of `~/.zshrc`, so the new alias is there. On your other machines, `configfile update` does the same.

:::tip
To set up a new machine, install *configfile*, then run `configfile init`, `configfile modules deploy --all` and your setup script.
:::

## 8. See what happened, and undo it

*configfile* records every change it makes. In `configfile history`, the deployment and the sync look like this:

```sh
configfile history
```

```txt
2026-10-08 11:29  modules deploy zsh  ok
  copied    ~/.zshrc  (previous file moved to ~/.zshrc.old)

2026-10-08 11:29  update  ok
  synced    ~/.configfile/dotfiles  with origin/main (f9a3f1e → 117f764)
  updated   ~/.zshrc
```

And every deployment can be reverted. `undeploy` removes the copy and puts your previous file back (a copy changed on this machine is kept, and so is your previous file, as `.old`):

```sh
configfile modules undeploy zsh
```

```txt
 Info  Undeploying zsh…
- ~/.zshrc (removed, ~/.zshrc.old restored)
 Done  Undeployment finished.
```

## Next steps

- [Modules and their settings](/reference/modules/): local files copied into a project, files kept in the repository without being deployed, and every rule for targets.
- [Scripts](/reference/scripts/): scripts in any language, folder scripts, and versions per system (`setup.macos.sh`).
- [Run scripts when a module is deployed](/guides/module-scripts/): install plugins or start a service each time a module is deployed, and clean up when it is undeployed.
- [Commands](/reference/commands/): every command and option, including the ones for running *configfile* from scripts and CI.

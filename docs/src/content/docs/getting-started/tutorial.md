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

Create an empty repository named `dotfiles` on GitHub, then clone it. This clone is your **working copy**: it's where you edit your dotfiles.

```sh
git clone git@github.com:me/dotfiles.git ~/dotfiles
cd ~/dotfiles
```

## 2. Add a first module

A **module** is a folder of `files/` that groups the configuration of one tool. Create one for zsh, with the file you want on every machine:

```sh
mkdir -p files/zsh
echo 'alias ll="ls -la"' > files/zsh/zshrc
```

Then tell *configfile* where this file goes, in the module's `settings.json`:

```json title="files/zsh/settings.json"
{
  "files": [
    { "source_path": "zshrc", "target_path": "~/.zshrc", "deploy": "global" }
  ]
}
```

`"deploy": "global"` means the file is linked into your home folder. The [modules reference](/reference/modules/) lists every option.

## 3. Add a setup script

Scripts go in `scripts/`. They're handy for what files alone can't do, such as installing tools:

```sh title="scripts/setup.sh"
#!/bin/sh
echo "Setting up $CONFIGFILE_OS from $CONFIGFILE_REPO"
```

`CONFIGFILE_OS` and `CONFIGFILE_REPO` are set by *configfile* when it runs the script (see [Scripts](/reference/scripts/)).

Commit and push:

```sh
git add .
git commit -m "First module"
git push
```

Your repository now looks like this:

```txt
files/
    zsh/
        settings.json
        zshrc
scripts/
    setup.sh
```

## 4. Connect configfile to the repository

```sh
configfile init --repo git@github.com:me/dotfiles.git
```

```txt
 Info  Cloning git@github.com:me/dotfiles.git into ~/.configfile/dotfiles…
Cloning into '/Users/me/.configfile/dotfiles'...
done.
 Done  configfile is ready. Configuration saved to ~/.configfilerc.
```

*configfile* keeps its own copy of the repository in `~/.configfile/dotfiles`, and deploys from it. You never edit this copy: you edit your working copy, push, and *configfile* follows. [How it works](/concepts/how-it-works/) explains why.

## 5. Deploy the module

Check where things stand:

```sh
configfile modules status
```

```txt
zsh:
  ~/.zshrc (not deployed: a file is in the way)
```

You probably already have a `~/.zshrc`. Preview what deploying would do, without changing anything:

```sh
configfile modules deploy zsh --dry-run
```

```txt
 Info  Dry run, nothing is changed. Deploying zsh would do:
- ~/.zshrc (would be linked, the existing file moved to ~/.zshrc.old)
 Done  Dry run finished.
```

Your current file is kept, as `~/.zshrc.old`. Deploy:

```sh
configfile modules deploy zsh
```

```txt
 Info  Deploying zsh…
- ~/.zshrc (deployed, previous file moved to ~/.zshrc.old)
 Done  Deployment finished.
```

`~/.zshrc` is now a link to the file in the repository:

```sh
ls -l ~/.zshrc
# ~/.zshrc -> ~/.configfile/dotfiles/files/zsh/zshrc
```

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
 Done  Synced with origin/main (117f764). Global files are links, so they are up to date; run "configfile modules deploy --all" for new files.
```

Because `~/.zshrc` is a link, the new alias is there right away. On your other machines, `configfile update` does the same.

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
  linked    ~/.zshrc  (previous file moved to ~/.zshrc.old)

2026-10-08 11:29  update  ok
  synced    ~/.configfile/dotfiles  with origin/main (f9a3f1e → 117f764)
```

And every deployment can be reverted. `undeploy` removes the link and puts your previous file back:

```sh
configfile modules undeploy zsh
```

```txt
 Info  Undeploying zsh…
- ~/.zshrc (removed, ~/.zshrc.old restored)
 Done  Undeployment finished.
```

## Next steps

- [Modules and `settings.json`](/reference/modules/): local files copied into a project, files kept in the repository without being deployed, and every rule for targets.
- [Scripts](/reference/scripts/): scripts in any language, folder scripts, and versions per system (`setup.macos.sh`).
- [Commands](/reference/commands/): every command and option, including the ones for running *configfile* from scripts and CI.

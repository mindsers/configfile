---
title: How it works
description: Where your dotfiles live, how configfile deploys them, and how it keeps track of what it did.
sidebar:
  order: 1
---

*configfile* doesn't store your configuration files. They live in a git repository that you own, usually called `dotfiles` ([plenty of people share theirs](https://github.com/topics/dotfiles)). *configfile* puts the files of that repository where your tools expect them, runs your setup scripts, and keeps each machine in sync with the repository.

## Where your files live

Your dotfiles exist in up to four places:

```txt
your working copy     ~/dotfiles
        │
        │  git push
        ▼
remote repository     GitHub, GitLab…
        │
        │  configfile update
        ▼
configfile's mirror   ~/.configfile/dotfiles
        │
        │  configfile modules deploy (once per file)
        ▼
your home folder      ~/.zshrc → link into the mirror
```

- **Your working copy** is a clone of the repository, wherever you like. It's the only place where you edit your dotfiles, commit and push, as for any git repository.
- **The remote repository** is the reference that every machine follows.
- **configfile's mirror** is a copy of the remote repository that *configfile* keeps for itself, in `~/.configfile/dotfiles` unless you chose another folder with `configfile init --folder`. [`configfile update`](/reference/commands/#configfile-update) makes it identical to the remote.
- **Your home folder** receives the files your tools read, such as `~/.zshrc`; project folders receive local copies.

### Why a mirror, and not your working copy

If *configfile* deployed from your working copy, uncommitted edits, a branch you're working on or a conflict would block syncing, and changes you haven't pushed yet would reach your configuration before your other machines have them.

The mirror only follows the remote. `update` doesn't merge anything, so your work in progress never blocks it: it fetches the remote and makes the mirror identical to it. It still needs the remote to be reachable, and stops with an error if fetching fails.

You don't edit the mirror. If something changes in it anyway, for example an edit made through a deployed link, `update` first saves the uncommitted changes and unpushed commits as a patch in `~/.configfile/saved/`, so that you can recover them: apply the patch in your working copy with `git am`.

:::caution
`update` resets the mirror's folder, whatever it is. A configuration made with *configfile* 0.3 may point to your own working copy (for example `~/.dotfiles`): `update` would then reset your working copy to the remote, after saving its uncommitted changes and unpushed commits as a patch. [Upgrading from 0.3](/guides/upgrading-from-0-3/) explains how to give *configfile* its own copy.
:::

## The repository's layout

```txt
files/            one folder per module
    zsh/
        settings.json
        zshrc
    git/
        settings.json
        gitconfig
scripts/          setup scripts, run with configfile scripts run <name>
    setup.sh
```

A **module** is a folder of `files/` that groups the configuration of one tool. Its `settings.json` lists the module's files: each **entry** names a file of the module, where it goes, and how it's deployed. Scripts in `scripts/` do what files alone can't, such as installing tools. The [modules](/reference/modules/) and [scripts](/reference/scripts/) references describe both folders in detail, and [Your first dotfiles repository](/getting-started/tutorial/) builds one step by step.

## How files are deployed

Each entry says how its file is deployed:

- **Global files are linked.** `~/.zshrc` becomes a symbolic link to the file in the mirror. You deploy a file once: when `update` brings a new version, the link already points to it.
- **Local files are copied** into the current folder by `configfile modules deploy --local`. They suit files that belong in each project, such as an `.editorconfig`, and that a project may change. A copy doesn't follow the repository: deploy it again to refresh it, and *configfile* asks before replacing a copy that differs.

An entry with `"deploy": "none"` stays in the repository without being deployed.

## Keeping track

*configfile* records each file it deploys, and each file it moves aside, in `~/.configfile/state.json`. That record is what lets it:

- show what is deployed, with [`configfile modules status`](/reference/commands/#configfile-modules-status);
- undo a deployment, with [`configfile modules undeploy`](/reference/commands/#configfile-modules-undeploy), putting back the file it replaced;
- find the files it deployed for entries that have since left the repository, which `update` warns about and `configfile modules undeploy --removed` removes.

It also logs each run of the commands that change things (`init`, `modules deploy` and `undeploy` except dry runs, `update`, `scripts run`) in `~/.configfile/history.jsonl`, along with any command that fails unexpectedly; [`configfile history`](/reference/history/) shows them. [Safety and trust](/concepts/safety/) explains how *configfile* avoids losing or overwriting your files.

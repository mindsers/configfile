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
        │  configfile modules deploy
        ▼
your home folder      ~/.zshrc → link into the mirror
```

- **Your working copy** is a clone of the repository, wherever you like. It's the only place where you edit your dotfiles, commit and push, as for any git repository.
- **The remote repository** is the reference that every machine follows.
- **configfile's mirror**, in `~/.configfile/dotfiles`, is a copy of the remote repository that *configfile* keeps for itself. `configfile update` makes it identical to the remote.
- **Your home folder**, and project folders for local files, is where *configfile* deploys the files.

### Why a mirror, and not your working copy

If *configfile* deployed from your working copy, syncing would depend on its state: uncommitted edits, a branch you're working on, commits you haven't pushed or a conflict would all block `update`, or deploy files you didn't mean to share yet.

The mirror only ever follows the remote, so `update` always succeeds and every machine gets exactly what you pushed. You don't edit the mirror. If something changes in it anyway, for example an edit made through a deployed link, `update` saves the change as a patch in `~/.configfile/saved/` before resetting the mirror, so nothing is lost; apply the patch in your working copy with `git am` to keep it.

## Two ways to deploy a file

Each file of a module says in its `settings.json` how it's deployed:

- **Global files are linked.** `~/.zshrc` becomes a symbolic link to the file in the mirror. When `update` brings a new version, the link already points to it: nothing else to do.
- **Local files are copied** into the current folder by `configfile modules deploy --local`. They suit files that belong in each project, such as an `.editorconfig`, and that a project may change. A copy doesn't follow the repository: deploy it again to refresh it, and *configfile* asks before replacing a copy that differs.
- **`"deploy": "none"`** keeps a file in the repository without deploying it.

## Keeping track

*configfile* records each file it deploys, and each file it moves aside, in `~/.configfile/state.json`. That record is what lets it:

- show what is deployed, with `configfile modules status`;
- undo a deployment, with `configfile modules undeploy`, restoring the file it replaced;
- notice files it deployed for entries that have since left the repository, and remove them when you ask.

It also logs each run of the commands that change things (`init`, `modules deploy` and `undeploy`, `update`, `scripts run`) in `~/.configfile/history.jsonl`, which `configfile history` shows. [Safety and trust](/concepts/safety/) explains the rules *configfile* follows to never lose a file.

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
    macos/
        index.sh
```

The [modules](/reference/modules/) and [scripts](/reference/scripts/) references describe both folders in detail, and [Your first dotfiles repository](/getting-started/tutorial/) builds one step by step.

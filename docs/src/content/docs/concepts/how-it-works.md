---
title: How it works
description: Your dotfiles repository, the mirror configfile keeps, and what it deploys from it.
---

This tool **does not store** configuration files for you. A git repository ([dotfiles](https://github.com/topics/dotfiles)) is needed to store your configuration files.

You edit your dotfiles in your own working copy of that repository and push them. *configfile* keeps its own copy, a mirror of the remote repository in `~/.configfile/dotfiles`, and deploys from it: `configfile update` makes the mirror identical to the remote, so unpushed or conflicting work never blocks it. Don't edit the mirror (or deployed links, which point into it): see [`update`](/reference/commands/) for what happens to such changes.

The repository must have this structure:

```txt
files/
    zsh/
        settings.json
        zshrc
    git/
        settings.json
        gitconfig
scripts/
    setup.sh
    macos/
        index.sh
```

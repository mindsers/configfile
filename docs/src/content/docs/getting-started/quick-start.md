---
title: Quick start
description: Point configfile to your dotfiles repository.
---

Generating first configuration:

```bash
configfile init
```

It asks for your repository URL and clones it into `~/.configfile/dotfiles`, a copy configfile keeps in sync with the remote (edit your dotfiles in your own working copy). To set it up without questions (in a script, for example):

```bash
configfile init --repo git@github.com:me/dotfiles.git
```

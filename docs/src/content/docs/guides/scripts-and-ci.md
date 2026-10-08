---
title: Use configfile in scripts and CI
description: Run configfile without a terminal, rely on its exit codes, and check a dotfiles repository on every push.
sidebar:
  order: 2
---

Every *configfile* command can run without anyone at the keyboard: in a bootstrap script, a cron job, or a CI workflow. This guide covers what changes without a terminal, and how to check your dotfiles repository automatically.

## Answering questions with options

When it runs in a terminal, *configfile* asks for what it needs. When its input is not a terminal, it can't ask: a command that would need an answer stops with an error that names the option to pass instead.

```txt
$ configfile modules deploy < /dev/null
 Error  No module given. Pass module names, or --all to deploy every module.
```

| Command | Question in a terminal | Option to pass instead |
| --- | --- | --- |
| `configfile init` | the repository's URL | `--repo <url>` |
| `configfile init` | whether to replace an existing configuration | `--force` |
| `configfile modules deploy` and `undeploy` | whether to use every module | module names, or `--all` |
| `configfile modules deploy --local` | whether to replace an existing file that differs | `--force` (without it, the file is skipped and the command fails) |

`configfile init --folder <path>` also lets a script choose where the repository is cloned. The [commands reference](/reference/commands/) lists every option.

## Exit codes

*configfile* exits with:

- `0` when the command succeeded;
- another code when it failed, with an error message saying why: usually `1`, or git's own code when a git command fails (for example `128` when the repository can't be fetched);
- the script's own exit code with `configfile scripts run`, so a failing setup script fails the step that runs it;
- `130` when you press Ctrl+C at a question.

In a shell script, `set -e` therefore stops at the first *configfile* command that fails.

## Output

With `configfile scripts run`, *configfile*'s own messages go to stderr and the script's output to stdout, unchanged: you can pipe or redirect the script's output as if you had run it directly.

`configfile history --json` prints the [history](/reference/history/) as JSON Lines, one run per line, for scripts that need to know what *configfile* did.

## Check your dotfiles repository on every push

A mistake in a `settings.json`, such as invalid JSON, a missing `target_path`, or a target *configfile* refuses, is usually found on the next machine you set up. A CI workflow can find it when you push, by deploying the repository into a throwaway home folder with `--dry-run`: *configfile* reads every module and entry, checks every target, and exits with `1` if anything can't be deployed.

With GitHub Actions, add this workflow to your dotfiles repository:

```yaml title=".github/workflows/check.yml"
name: Check dotfiles

on: [push, pull_request]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm install --global https://github.com/mindsers/configfile/releases/download/1.0.0/configfile-1.0.0.tgz
      # The following steps use a throwaway home folder, not the runner's.
      - run: |
          mkdir -p "$RUNNER_TEMP/home"
          echo "HOME=$RUNNER_TEMP/home" >> "$GITHUB_ENV"
      - run: configfile init --repo "$GITHUB_WORKSPACE"
      - run: configfile modules deploy --all --dry-run
```

`init` accepts a local folder as the repository, here the checkout of the commit being tested. Nothing is deployed for real, and the runner's home folder isn't touched. The dry run fails if any module or entry is invalid, even when the others are fine, local files included. A file whose entry has no `deploy` strategy only produces a warning, as it does on your machines.

To also test your setup script, add a step that runs it, on the systems it supports:

```yaml
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      # … the steps above, then:
      - run: configfile scripts run setup
```

Run it only if the script is safe to run on a fresh CI machine: it installs and changes things for real, as on your own computer.

:::tip
In your editor, the [JSON Schema of `settings.json`](/reference/modules/#completion-and-validation-in-your-editor) catches most of these mistakes before you even commit.
:::

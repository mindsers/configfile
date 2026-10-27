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
| `configfile init` | whether to set *configfile* up again (it undeploys everything, then deletes its configuration and folder) | `--force` |
| `configfile init` | whether to run the repository's `post_init` script | `--hooks` (without it, the script is not run, with a warning, and the command succeeds; `--no-hooks` never runs it, nor, when setting *configfile* up again, the undeploy scripts of the modules) |
| `configfile modules deploy` and `undeploy` | whether to use every module | module names, or `--all` |
| `configfile modules deploy --local` | whether to replace an existing file that differs | `--force` (without it, the file is skipped and the command fails) |
| `configfile modules deploy` | whether to replace a copy changed both on this machine and in the repository, or a changed copy with a link | `--force` (without it, the file is kept and the command fails) |

Two more options matter in a script, although no question stands behind them: `--keep-going` deploys (or undeploys) the remaining modules when a [script named by a module](/guides/module-scripts/) fails, and `--no-hooks` runs none of these scripts.

`configfile init --folder <path>` also lets a script choose where the repository is cloned. The [commands reference](/reference/commands/) lists every option.

## Exit codes

*configfile* exits with:

- `0` when the command succeeded;
- another code when it failed, with an error message saying why: usually `1`, or git's own code when a git command fails (for example `128` when the repository can't be fetched);
- the script's own exit code with `configfile scripts run`, so a failing setup script fails the step that runs it;
- `1` when a [script named by a module](/guides/module-scripts/) fails during `modules deploy` or `undeploy`, or a [script named by the repository](/reference/modules/#run-scripts-after-update-and-init) is missing or fails after `update` or `init` (its own exit code is in the [history](/reference/history/));
- `130` when you press Ctrl+C at a question, or while a script named by a module runs (`143` when *configfile* gets SIGTERM during such a script).

In a shell script, `set -e` therefore stops at the first *configfile* command that fails.

Commands that change files (`init`, `update`, `modules deploy` and `undeploy`) never change files at the same time: a command started while another holds the lock waits for it, saying `Waiting for another configfile (process N) to finish…`, and fails with `1` after 10 seconds. `modules deploy` and `undeploy` release the lock between two modules, so another command can run in between. In a script, run them one after the other, for example `update`, then `modules deploy --all`.

A git prompt for a password or a passphrase makes `update` and `init` wait for an answer, and holds the lock meanwhile: without a terminal it fails. Give scripts a way to reach the repository without a question, such as an SSH key loaded in an agent or a git credential helper.

## Output

With `configfile scripts run`, *configfile*'s own messages go to stderr and the script's output to stdout, unchanged: you can pipe or redirect the script's output as if you had run it directly. During `modules deploy` and `undeploy`, the output of the scripts named by the modules is mixed with *configfile*'s on stdout.

`configfile history --json` prints the [history](/reference/history/) as JSON Lines, one run per line, for scripts that need to know what *configfile* did.

## Check your dotfiles repository on every push

A mistake in the settings of a module, such as invalid JSON, a missing `target_path`, or a target *configfile* refuses, is usually found on the next machine you set up. A CI workflow can find it when you push, by deploying the repository into a throwaway home folder with `--dry-run`: *configfile* reads every module and entry, checks every target, and exits with `1` if anything can't be deployed.

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

`init` accepts a local folder as the repository, here the checkout of the commit being tested. Nothing is deployed for real, and the runner's home folder isn't touched. The dry run fails if any module or entry is invalid, even when the others are fine, local files included. It lists the scripts the modules name to run when they are deployed, without running them, and fails before listing anything if one of them doesn't exist. A file whose entry has no `deploy` strategy only produces a warning, as it does on your machines.

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
In your editor, the [JSON Schema of the settings of a module](/reference/modules/#completion-and-validation-in-your-editor) catches most of these mistakes before you even commit.
:::

# Security policy

*configfile* changes files in your home folder and runs scripts on your machine, so security problems matter. Thank you for reporting them responsibly.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x (latest release) | Yes |
| 0.3 and older | No |

Fixes are released in a new 1.x version. Please check the issue still happens with the latest release before reporting it.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a vulnerability.**

Report it privately with GitHub's private vulnerability reporting: go to the [Security tab](https://github.com/mindsers/configfile/security) of the repository and click **Report a vulnerability**, or open [a new security advisory](https://github.com/mindsers/configfile/security/advisories/new) directly.

Please include:

- the *configfile* version (`configfile --version`), Node.js version and operating system;
- what an attacker can do, and what they need first (for example, control of the dotfiles repository, or another local user account);
- the steps to reproduce it, ideally with a minimal dotfiles repository or `settings.json`;
- any idea of a fix, if you have one.

The report stays private while it is investigated. You will get an answer in the advisory, and be credited in it when the fix is released, unless you prefer not to be.

## What counts as a vulnerability

*configfile* deploys the files of a dotfiles repository and runs its scripts. **Deploying a repository means trusting it**, like code you run: a repository you chose running a harmful script is not a vulnerability in *configfile*.

These are, for example:

- a file deployed, replaced or removed outside its `target_path`, or a `source_path` read outside its module folder;
- a file you own deleted or overwritten without being moved aside to a `.old` backup;
- another local user making *configfile* write or read files through links in shared folders;
- credentials (from a repository URL, for example) written to the history, the configuration or the terminal where they should be hidden;
- a script run, or a command executed, that the user did not ask for.

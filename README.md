# configfile

[![Release](https://img.shields.io/github/v/release/mindsers/configfile?style=flat-square)](https://github.com/mindsers/configfile/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/mindsers/configfile/ci.yml?branch=develop&style=flat-square)](https://github.com/mindsers/configfile/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/mindsers/configfile?style=flat-square)](https://github.com/mindsers/configfile/blob/develop/LICENSE)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/mindsers?logo=githubsponsors&style=flat-square)](https://github.com/sponsors/mindsers)

*configfile* manages your configuration files (dotfiles) and setup scripts from a git repository you own. It links each file where your tools expect it, runs your setup scripts, and keeps every machine in sync with the repository, on macOS and Linux.

**Documentation: [docs.configfile.sh](https://docs.configfile.sh)**

## How it looks

Your repository groups files by tool, and says where each one goes:

```txt
files/
    zsh/
        settings.json
        zshrc
scripts/
    setup.sh
```

```json
{
  "files": [
    { "source_path": "zshrc", "target_path": "~/.zshrc", "deploy": "global" }
  ]
}
```

On each machine:

```sh
configfile init --repo git@github.com:me/dotfiles.git   # once
configfile modules deploy --all                         # links ~/.zshrc, keeping the old one as ~/.zshrc.old
configfile scripts run setup                            # runs scripts/setup.sh
configfile update                                       # later: brings the changes you pushed
```

## Installation

With [Homebrew](https://brew.sh), on macOS or Linux (Node.js and git come with it):

```bash
brew install mindsers/tap/configfile
```

With npm, when Node.js 24.11 or later is installed:

```bash
npm install --global https://github.com/mindsers/configfile/releases/download/1.0.0/configfile-1.0.0.tgz
```

[Installation](https://docs.configfile.sh/getting-started/installation/) has the details, including how to verify a download.

## Learn more

- [Your first dotfiles repository](https://docs.configfile.sh/getting-started/tutorial/): a ten-minute tutorial.
- [How it works](https://docs.configfile.sh/concepts/how-it-works/) and [Safety and trust](https://docs.configfile.sh/concepts/safety/): what *configfile* does with your files, and what it refuses to touch.
- Guides: [set up a new machine](https://docs.configfile.sh/guides/new-machine/), [use configfile in scripts and CI](https://docs.configfile.sh/guides/scripts-and-ci/), [upgrade from 0.3](https://docs.configfile.sh/guides/upgrading-from-0-3/).
- Reference: [commands](https://docs.configfile.sh/reference/commands/), [modules and `settings.json`](https://docs.configfile.sh/reference/modules/), [scripts](https://docs.configfile.sh/reference/scripts/), [configuration](https://docs.configfile.sh/reference/configuration/), [history](https://docs.configfile.sh/reference/history/).
- [Changelog](https://github.com/mindsers/configfile/blob/develop/CHANGELOG.md).

## Contribution

Contributions are welcome and greatly appreciated. Read [How to contribute to configfile](https://github.com/mindsers/configfile/blob/develop/CONTRIBUTING.md) before opening a pull request, and follow the [code of conduct](https://github.com/mindsers/configfile/blob/develop/CODE_OF_CONDUCT.md).

- **Questions and bugs:** [open an issue](https://github.com/mindsers/configfile/issues/new/choose).
- **Security vulnerabilities:** never in a public issue. See the [security policy](https://github.com/mindsers/configfile/blob/develop/SECURITY.md).

## Support

*configfile* is free and open source software, under the Apache-2.0 license, built on my free time.

If you use it and want to support its development, you can sponsor me on [GitHub Sponsors](https://github.com/sponsors/mindsers). Thank you!

The people who support *configfile* are listed in [SPONSORS.md](https://github.com/mindsers/configfile/blob/develop/SPONSORS.md).

## License

This project is under the Apache-2.0 license. See the [LICENSE](https://github.com/mindsers/configfile/blob/develop/LICENSE) file.

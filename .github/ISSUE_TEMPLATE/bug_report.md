---
name: Bug report
about: Something configfile does wrong
title: ''
labels: 'type: bug'
assignees: ''

---

<!-- Security vulnerabilities must not be reported here: see SECURITY.md. -->

**Describe the bug**
A clear and concise description of what the bug is.

**To reproduce**
The commands you ran, in order, for example:
1. `configfile init --repo <url>`
2. `configfile modules deploy zsh`

If the bug depends on a module, add its `settings.json` (remove anything private).

**Expected behavior**
What you expected to happen.

**Output**
What configfile printed. Running the command again with `DEBUG=1` adds details to unexpected errors.

```txt

```

The last runs of `configfile history` often help too. Check them for paths or names you would rather not share.

**Environment**
- configfile version (`configfile --version`):
- Node.js version (`node --version`):
- Operating system and version:
- Installed with (npm, pnpm, yarn…):

**Additional context**
Anything else about the problem.

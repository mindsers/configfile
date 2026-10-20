#!/bin/sh
# Installs configfile on macOS or Linux, without Node.js or a package manager:
#
#   curl -fsSL https://configfile.sh/install.sh | sh
#
# It downloads the standalone binary for this system from the GitHub release,
# checks it against the release's SHA256SUMS, and installs it as
# ~/.local/bin/configfile. Run it again to update configfile.
#
# Settings, as environment variables (put them before `sh`):
#   CONFIGFILE_VERSION       the version to install (default: the latest release;
#                            releases have binaries from the one that
#                            introduced them, 1.0.0 has none)
#   CONFIGFILE_INSTALL_DIR   where to install it (default: ~/.local/bin)
#   CONFIGFILE_DOWNLOAD_URL  where releases are downloaded from (default: the
#                            GitHub releases of mindsers/configfile; for tests
#                            and mirrors)
#
# Source: https://github.com/mindsers/configfile/blob/master/docs/public/install.sh
# Published with the documentation at https://docs.configfile.sh/install.sh,
# where https://configfile.sh/install.sh redirects: the old address and the
# redirect both rely on this file staying in docs/public/.

set -eu

releases="${CONFIGFILE_DOWNLOAD_URL:-https://github.com/mindsers/configfile/releases}"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'configfile installer: %s\n' "$*" >&2
  exit 1
}

# The name of the archive for this system, such as configfile-macos-arm64.tar.gz.
archive_name() {
  case "$(uname -s)" in
    Darwin) system=macos ;;
    Linux) system=linux ;;
    *) fail "no configfile binary for $(uname -s): it runs on macOS and Linux." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "no configfile binary for $(uname -m) processors: install it with npm instead (https://docs.configfile.sh/getting-started/installation/)." ;;
  esac
  # A shell running under Rosetta reports x86_64 on Apple silicon.
  if [ "$system" = macos ] && [ "$arch" = x64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  # The binaries are built for the GNU C library, which Alpine doesn't use.
  if [ "$system" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    fail "the configfile binary needs the GNU C library, not musl (Alpine): install it with npm instead (https://docs.configfile.sh/getting-started/installation/)."
  fi
  say "configfile-$system-$arch.tar.gz"
}

download() { # url file
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$2" "$1" || fail "cannot download $1."
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || fail "cannot download $1."
  else
    fail "curl or wget is needed to download configfile."
  fi
}

sha256() { # file
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "sha256sum or shasum is needed to check the download."
  fi
}

main() {
  name="$(archive_name)"
  version="${CONFIGFILE_VERSION:-latest}"
  if [ "$version" = latest ]; then
    base="$releases/latest/download"
  else
    base="$releases/download/$version"
  fi
  dir="${CONFIGFILE_INSTALL_DIR:-$HOME/.local/bin}"

  work="$(mktemp -d)"
  draft="$dir/.configfile.$$"
  trap 'rm -rf "$work"; rm -f "$draft"' EXIT
  # Stopped (Ctrl+C, kill): ends here, the exit trap cleaning up.
  trap 'exit 130' INT
  trap 'exit 143' TERM

  say "Downloading $base/$name..."
  download "$base/$name" "$work/$name"
  download "$base/SHA256SUMS" "$work/SHA256SUMS"
  expected="$(awk -v name="$name" '$2 == name || $2 == "*" name { print $1 }' "$work/SHA256SUMS")"
  [ -n "$expected" ] || fail "SHA256SUMS of the release has no line for $name."
  actual="$(sha256 "$work/$name")"
  [ "$actual" = "$expected" ] ||
    fail "$name does not match the checksum of the release: it was not installed."

  tar -xzf "$work/$name" -C "$work" ./configfile || fail "cannot extract $name."
  mkdir -p "$dir" || fail "cannot create $dir."
  { cp "$work/configfile" "$draft" && chmod 755 "$draft"; } || fail "cannot install configfile in $dir."
  # Checked before it replaces anything: an installed configfile is kept when
  # the new one cannot run on this system.
  installed="$("$draft" --version)" ||
    fail "the downloaded configfile does not start on this system: nothing was changed in $dir."
  # Moved into place in one step, so a configfile running meanwhile is not cut short.
  mv -f "$draft" "$dir/configfile" || fail "cannot install configfile in $dir."
  say "configfile $installed is installed in $dir/configfile."

  case ":$PATH:" in
    *":$dir:"*)
      found="$(command -v configfile || true)"
      if [ -n "$found" ] && [ "$found" != "$dir/configfile" ]; then
        say "Another configfile comes first in your PATH: $found. Remove it, or put $dir first."
      fi
      ;;
    *) say "$dir is not in your PATH: add it to your shell's profile, for example: export PATH=\"$dir:\$PATH\"" ;;
  esac
  if ! command -v git >/dev/null 2>&1; then
    case "$(uname -s)" in
      Darwin) say "configfile needs git: install it with xcode-select --install" ;;
      *) say "configfile needs git: install it with your system's package manager." ;;
    esac
  fi
  say 'Next: run "configfile init" to connect it to your dotfiles repository.'
}

main

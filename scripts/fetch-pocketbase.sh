#!/bin/sh
# Download the PocketBase release named in .pocketbase-version into bin/pocketbase,
# checked against the sha256 committed in .pocketbase-sha256. Used by the tests and by
# a server install. Linux and macOS, amd64 and arm64.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
version=$(cat "$root/.pocketbase-version")
case $(uname -s) in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported OS" >&2; exit 1 ;; esac
case $(uname -m) in x86_64 | amd64) arch=amd64 ;; aarch64 | arm64) arch=arm64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac
if [ -x "$root/bin/pocketbase" ] && "$root/bin/pocketbase" --version | grep -qx "pocketbase version $version"; then exit 0; fi
name=pocketbase_${version}_${os}_${arch}.zip
want=$(grep " $name\$" "$root/.pocketbase-sha256" | cut -d' ' -f1)
[ -n "$want" ] || { echo "no sha256 for $name in .pocketbase-sha256" >&2; exit 1; }
mkdir -p "$root/bin"
# Inside bin/ so the final mv is a rename on one filesystem: the running server keeps its
# old binary open, and the new one appears whole.
tmp=$(mktemp -d "$root/bin/.fetch.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$name" "https://github.com/pocketbase/pocketbase/releases/download/v$version/$name"
# macOS has shasum but no sha256sum
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/$name"); else got=$(shasum -a 256 "$tmp/$name"); fi
[ "${got%% *}" = "$want" ] || { echo "sha256 mismatch for $name" >&2; exit 1; }
unzip -oq "$tmp/$name" pocketbase -d "$tmp"
mv -f "$tmp/pocketbase" "$root/bin/pocketbase"

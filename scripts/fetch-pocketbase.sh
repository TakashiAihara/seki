#!/bin/sh
# Download the PocketBase release named in .pocketbase-version into bin/pocketbase.
# Used by the tests and by a server install. Linux and macOS, amd64 and arm64.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
version=$(cat "$root/.pocketbase-version")
case $(uname -s) in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported OS" >&2; exit 1 ;; esac
case $(uname -m) in x86_64 | amd64) arch=amd64 ;; aarch64 | arm64) arch=arm64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac
if [ -x "$root/bin/pocketbase" ] && "$root/bin/pocketbase" --version | grep -qx "pocketbase version $version"; then exit 0; fi
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
name=pocketbase_${version}_${os}_${arch}.zip
base=https://github.com/pocketbase/pocketbase/releases/download/v$version
curl -fsSL -o "$tmp/$name" "$base/$name"
curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"
# macOS has shasum but no sha256sum
if command -v sha256sum >/dev/null 2>&1; then sum="sha256sum -c -"; else sum="shasum -a 256 -c -"; fi
(cd "$tmp" && grep " $name\$" checksums.txt | $sum >/dev/null) || { echo "checksum mismatch for $name" >&2; exit 1; }
mkdir -p "$root/bin"
unzip -oq "$tmp/$name" pocketbase -d "$tmp"
# rename, not overwrite: the running server keeps its old binary open (ETXTBSY otherwise)
mv -f "$tmp/pocketbase" "$root/bin/pocketbase"

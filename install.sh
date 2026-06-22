#!/usr/bin/env bash
# install.sh — put the self-locating `pmtools` dispatcher on your PATH.
#
# Symlinks bin/pmtools into a PATH dir (default ~/.local/bin). The dispatcher
# follows the symlink back to THIS clone, so the clone can live anywhere and you
# never hardcode its path in a config — consumers just call `pmtools <cmd>`.
#
#   ./install.sh              # symlink into ~/.local/bin
#   ./install.sh /usr/local/bin   # or another PATH dir
set -euo pipefail

here="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
target_dir="${1:-$HOME/.local/bin}"
mkdir -p "$target_dir"
ln -sf "$here/bin/pmtools" "$target_dir/pmtools"
chmod +x "$here/bin/pmtools"

echo "linked $target_dir/pmtools -> $here/bin/pmtools"
case ":$PATH:" in
  *":$target_dir:"*) echo "ok — $target_dir is on PATH; run: pmtools status" ;;
  *) echo "NOTE: $target_dir is not on PATH. Add it, e.g.:"
     echo "  export PATH=\"$target_dir:\$PATH\"" ;;
esac

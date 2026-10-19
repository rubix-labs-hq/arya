#!/bin/zsh
set -eu
reel_bridge_dir=${0:A:h}
reel_login_path=$(/bin/zsh -lc 'print -r -- "$PATH"')
export PATH="$reel_login_path:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset NODE_OPTIONS NODE_PATH
reel_node=${ARYA_BUNDLED_NODE:-}
if [[ -n "$reel_node" ]]; then
  if [[ "$reel_node" != /* || ! -f "$reel_node" || ! -x "$reel_node" || -L "$reel_node" ]]; then
    print "Arya's bundled bridge runtime is invalid. Download a fresh signed build."
    exit 1
  fi
else
  reel_node=$(command -v node || true)
fi
if [[ -z "$reel_node" ]] || ! "$reel_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  print 'This build needs Node.js 22 or newer. Use https://nodejs.org/en/download or a signed Arya build with the runtime included.'
  read '?Press Return to close.'
  exit 1
fi
reel_nonce_file="$reel_bridge_dir/.pairing-nonce"
if [[ ! -f "$reel_nonce_file" || -L "$reel_nonce_file" ]]; then
  print 'Start the agent bridge from Arya Assistant settings to pair it.'
  exit 1
fi
reel_pair_nonce=$(<"$reel_nonce_file")
if [[ ${#reel_pair_nonce} != 64 || "$reel_pair_nonce" == *[^a-f0-9]* ]]; then
  print 'The pairing request is invalid. Start the bridge again from Arya.'
  exit 1
fi
exec "$reel_node" "$reel_bridge_dir/bridge.mjs" --port 0 --pair --open --pair-nonce "$reel_pair_nonce"

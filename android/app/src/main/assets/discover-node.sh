declare -A seen_nodes
default_node="$(command -v node 2>/dev/null || true)"
default_node="$(readlink -f -- "$default_node" 2>/dev/null || true)"
inspect_node() {
  local candidate="$1" resolved version preferred=0
  [ -f "$candidate" ] && [ -x "$candidate" ] || return 0
  resolved="$(readlink -f -- "$candidate" 2>/dev/null)" || return 0
  [ -n "$resolved" ] || return 0
  [ -z "${seen_nodes[$resolved]+yes}" ] || return 0
  seen_nodes["$resolved"]=1
  if command -v timeout >/dev/null 2>&1; then
    version="$(timeout 2 "$resolved" --version 2>/dev/null)" || return 0
  else
    version="$("$resolved" --version 2>/dev/null)" || return 0
  fi
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([+-][a-zA-Z0-9.-]+)?$ ]] || return 0
  [ "$resolved" != "$default_node" ] || preferred=1
  printf '%s\t%s\t%s\n' "$version" "$resolved" "$preferred"
}
inspect_node "$default_node"
inspect_node "${PM2M_EXTRA_NODE:-}"
IFS=: read -ra node_path_dirs <<< "$PATH"
for directory in "${node_path_dirs[@]}"; do
  [[ "$directory" = /* ]] || continue
  inspect_node "$directory/node"
  inspect_node "$directory/nodejs"
done
for candidate in /usr/bin/node /usr/bin/nodejs /usr/local/bin/node /opt/node/bin/node \
  "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node \
  "${N_PREFIX:-/usr/local}"/n/versions/node/*/bin/node \
  "${FNM_DIR:-$HOME/.local/share/fnm}"/node-versions/*/installation/bin/node \
  "$HOME/.fnm"/node-versions/*/installation/bin/node \
  "${ASDF_DATA_DIR:-$HOME/.asdf}"/installs/nodejs/*/bin/node \
  "${NODENV_ROOT:-$HOME/.nodenv}"/versions/*/bin/node \
  "${VOLTA_HOME:-$HOME/.volta}"/tools/image/node/*/bin/node; do
  inspect_node "$candidate"
done
true

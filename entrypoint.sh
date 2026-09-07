#!/bin/sh
# Runs as root only long enough to make /state writable by the service user,
# then drops privileges. PUID/PGID default to Unraid's nobody:users (99:100)
# so a bind-mounted appdata folder works without manual chown. Containers
# started with --user skip this and run as that user directly.
set -eu
PUID="${PUID:-99}"
PGID="${PGID:-100}"
case "$PUID$PGID" in
  *[!0-9]*) echo "Invalid PUID/PGID: expected integers" >&2; exit 1 ;;
esac
if [ "$(id -u)" = "0" ]; then
  mkdir -p /state
  chown "$PUID:$PGID" /state 2>/dev/null || true
  for f in /state/*; do [ -e "$f" ] && chown "$PUID:$PGID" "$f" 2>/dev/null || true; done
  exec su-exec "$PUID:$PGID" node /app/janitor.mjs
fi
exec node /app/janitor.mjs

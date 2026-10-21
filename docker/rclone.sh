#!/bin/sh
# rclone, always as the backup server's user. Through `docker exec`, which
# runs as root, `rclone config` would write a configuration only root can
# read, and the backup server - PUID:PGID - could not use the remote; restic
# starts rclone as that user anyway.
set -eu

if [ "$(id -u)" = "0" ]; then
  exec su-exec "${PUID:-1000}:${PGID:-1000}" /usr/local/lib/rclone/rclone "$@"
fi

exec /usr/local/lib/rclone/rclone "$@"

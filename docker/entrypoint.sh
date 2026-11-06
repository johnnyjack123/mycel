#!/bin/sh
# Both images start here as root only long enough to hand their folders to the
# user the program runs as - PUID:PGID, 1000:1000 unless set - and then run it
# as that user. A bind-mounted folder Docker made belongs to root; without
# this, every setup needed a chown by hand first.
#
#   MYCEL_OWN       folders handed over with everything in them
#                              (only what is not theirs yet: a large folder is
#                              not walked again on every start)
#   MYCEL_OWN_TOP   folders handed over themselves, never what lies
#                              in them - the backup server's folders for
#                              repositories and copies may be a NAS share or
#                              a mounted cloud
#
# Started as another user (`user:` in compose), it runs the program as is; the
# program then says if it cannot write its folder.
set -eu

uid="${PUID:-1000}"
gid="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  for dir in ${MYCEL_OWN:-}; do
    mkdir -p "$dir"
    find "$dir" \( ! -user "$uid" -o ! -group "$gid" \) -exec chown "$uid:$gid" {} +
  done
  for dir in ${MYCEL_OWN_TOP:-}; do
    mkdir -p "$dir"
    # A mount that refuses (a network share squashing root) is left as it is.
    chown "$uid:$gid" "$dir" 2>/dev/null || echo "[mycel] could not hand $dir to $uid:$gid; it must be writable by that user" >&2
  done
  exec su-exec "$uid:$gid" "$@"
fi

exec "$@"

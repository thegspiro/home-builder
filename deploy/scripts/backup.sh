#!/bin/sh
# Back up the Home Builder database to a gzipped SQL file.
#
#   deploy/scripts/backup.sh [-d COMPOSE_DIR] [-o BACKUP_DIR] [-k KEEP_DAYS] [-l LABEL]
#
#   -d  Folder holding docker-compose.yml and .env (default: the folder above this script).
#   -o  Where backups go (default: $BACKUP_DIR, else APPDATA_DIR from .env + /backups).
#   -k  Delete backups older than this many days (default: 14; 0 keeps everything).
#   -l  Extra word in the file name, e.g. "pre-restore" (letters, digits and dashes).
#
# The dump runs inside the db container with mysqldump --single-transaction, so the
# app keeps working while it runs. The MySQL password is read inside the container and
# never appears on a command line. A backup only counts once mysqldump has finished and
# its "Dump completed" footer is present; anything else is deleted and the script fails.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_DIR=$(dirname -- "$SCRIPT_DIR")
OUT_DIR=${BACKUP_DIR:-}
KEEP_DAYS=14
LABEL=

usage() {
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
}

fail() {
    printf 'backup: %s\n' "$*" >&2
    exit 1
}

log() {
    printf '%s backup: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

while getopts 'd:o:k:l:h' opt; do
    case $opt in
        d) COMPOSE_DIR=$OPTARG ;;
        o) OUT_DIR=$OPTARG ;;
        k) KEEP_DAYS=$OPTARG ;;
        l) LABEL=$OPTARG ;;
        *) usage ;;
    esac
done
shift $((OPTIND - 1))
[ $# -eq 0 ] || usage

case $KEEP_DAYS in
    '' | *[!0-9]*) fail "-k must be a whole number of days, got '$KEEP_DAYS'" ;;
esac
case $LABEL in
    *[!A-Za-z0-9-]*) fail "-l may only contain letters, digits and dashes" ;;
esac

[ -f "$COMPOSE_DIR/docker-compose.yml" ] || fail "no docker-compose.yml in $COMPOSE_DIR (use -d)"
[ -f "$COMPOSE_DIR/.env" ] || fail "no .env in $COMPOSE_DIR"

# Read APPDATA_DIR from .env as plain text (never source it: it is not a shell script).
if [ -z "$OUT_DIR" ]; then
    appdata=$(sed -n 's/^[[:space:]]*APPDATA_DIR[[:space:]]*=[[:space:]]*//p' "$COMPOSE_DIR/.env" |
        tail -n 1 | sed "s/^[\"']//; s/[\"'][[:space:]]*\$//; s/[[:space:]]*\$//")
    OUT_DIR=${appdata:-/mnt/user/appdata/home-builder}/backups
fi

compose() {
    docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/docker-compose.yml" "$@"
}

compose ps --status running --services 2>/dev/null | grep -qx db ||
    fail "the db container is not running (start it with: docker compose up -d db)"

umask 077
mkdir -p -- "$OUT_DIR"
stamp=$(date '+%Y%m%d-%H%M%S')
name="homebuilder-$stamp${LABEL:+-$LABEL}.sql.gz"
target="$OUT_DIR/$name"
partial="$OUT_DIR/.$name.partial"
sqlfile="$OUT_DIR/.$name.sql"
trap 'rm -f -- "$partial" "$sqlfile"' EXIT
trap 'exit 130' INT TERM

log "dumping the database to $target"
# Single quotes: the variables expand inside the container, not on this host.
# shellcheck disable=SC2016
compose exec -T db sh -c '
    case $MYSQL_DATABASE in
        "" | *[!A-Za-z0-9_]*) echo "unexpected MYSQL_DATABASE" >&2; exit 1 ;;
    esac
    MYSQL_PWD=$MYSQL_ROOT_PASSWORD exec mysqldump -u root \
        --single-transaction --quick --routines --events --triggers \
        --hex-blob --no-tablespaces --set-gtid-purged=OFF \
        --default-character-set=utf8mb4 "$MYSQL_DATABASE"
' >"$sqlfile" || fail "mysqldump failed; no backup was written"

tail -n 1 "$sqlfile" | grep -q -- '-- Dump completed' ||
    fail "the dump is incomplete; no backup was written"

gzip -c -- "$sqlfile" >"$partial"
gzip -t -- "$partial" || fail "the compressed backup failed its integrity check"
mv -f -- "$partial" "$target"
log "done: $target ($(wc -c <"$target" | tr -d ' ') bytes)"

if [ "$KEEP_DAYS" -gt 0 ]; then
    find "$OUT_DIR" -maxdepth 1 -type f -name 'homebuilder-*.sql.gz' -mtime +"$KEEP_DAYS" \
        -print -exec rm -f -- {} \; | while IFS= read -r old; do
        log "removed old backup $old"
    done
fi

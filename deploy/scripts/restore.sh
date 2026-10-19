#!/bin/sh
# Restore the Home Builder database from a backup made by backup.sh.
#
#   deploy/scripts/restore.sh [-d COMPOSE_DIR] [-y] [-n] BACKUP_FILE
#
#   -d  Folder holding docker-compose.yml and .env (default: the folder above this script).
#   -y  Don't ask for confirmation (for scripts).
#   -n  Skip the safety backup of the current database (not recommended).
#
# What it does:
#   1. checks that the file is a complete Home Builder backup;
#   2. backs up the current database first (label "pre-restore"), unless -n;
#   3. stops the app and worker, replaces the database with the backup's contents,
#      and starts them again. The app then applies any newer migrations itself.
#
# Everything in the current database is replaced, including changes made since the
# backup was taken.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_DIR=$(dirname -- "$SCRIPT_DIR")
ASSUME_YES=false
SAFETY_BACKUP=true

usage() {
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
}

fail() {
    printf 'restore: %s\n' "$*" >&2
    exit 1
}

log() {
    printf '%s restore: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

while getopts 'd:ynh' opt; do
    case $opt in
        d) COMPOSE_DIR=$OPTARG ;;
        y) ASSUME_YES=true ;;
        n) SAFETY_BACKUP=false ;;
        *) usage ;;
    esac
done
shift $((OPTIND - 1))
[ $# -eq 1 ] || usage
FILE=$1

[ -f "$COMPOSE_DIR/docker-compose.yml" ] || fail "no docker-compose.yml in $COMPOSE_DIR (use -d)"
[ -f "$COMPOSE_DIR/.env" ] || fail "no .env in $COMPOSE_DIR"
[ -f "$FILE" ] && [ -r "$FILE" ] || fail "cannot read $FILE"

compose() {
    docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/docker-compose.yml" "$@"
}

# --- 1. Check the backup before touching anything ----------------------------------------
log "checking $FILE"
gzip -t -- "$FILE" 2>/dev/null || fail "$FILE is not a valid gzip file (truncated or corrupt?)"
gzip -dc -- "$FILE" | tail -n 1 | grep -q -- '-- Dump completed' ||
    fail "$FILE is incomplete: the dump did not finish"
# shellcheck disable=SC2016 # the backticks are literal SQL quoting
gzip -dc -- "$FILE" | grep -q 'CREATE TABLE `kysely_migration`' ||
    fail "$FILE does not look like a Home Builder backup (no kysely_migration table)"

compose ps --status running --services 2>/dev/null | grep -qx db ||
    fail "the db container is not running (start it with: docker compose up -d db)"

if [ "$ASSUME_YES" != true ]; then
    [ -t 0 ] || fail "not running interactively; pass -y to confirm the restore"
    printf 'This replaces the whole Home Builder database with %s.\n' "$FILE"
    printf 'Type RESTORE to continue: '
    read -r answer || answer=
    [ "$answer" = RESTORE ] || fail "cancelled; nothing was changed"
fi

# --- 2. Safety backup ----------------------------------------------------------------------
if [ "$SAFETY_BACKUP" = true ]; then
    backup_dir=$(dirname -- "$FILE")
    "$SCRIPT_DIR/backup.sh" -d "$COMPOSE_DIR" -o "${BACKUP_DIR:-$backup_dir}" -k 0 -l pre-restore ||
        fail "the safety backup failed; nothing was changed"
fi

# --- 3. Replace the database ---------------------------------------------------------------
# Only stop the services that exist in this stack and are running.
running=$(compose ps --status running --services 2>/dev/null | grep -Ex 'app|worker' || true)
if [ -n "$running" ]; then
    log "stopping $(echo "$running" | tr '\n' ' ')"
    # shellcheck disable=SC2086 # one service name per word
    compose stop $running
fi

restart() {
    if [ -n "$running" ]; then
        log "starting $(echo "$running" | tr '\n' ' ')"
        # shellcheck disable=SC2086
        compose up -d $running
    fi
}

log "replacing the database"
# The database is dropped and recreated so that tables added after the backup was
# taken don't survive it. The app user's privileges are stored by database name, so
# they are unaffected. Single quotes: the variables expand inside the container.
# shellcheck disable=SC2016
if ! gzip -dc -- "$FILE" | compose exec -T db sh -c '
    case $MYSQL_DATABASE in
        "" | *[!A-Za-z0-9_]*) echo "unexpected MYSQL_DATABASE" >&2; exit 1 ;;
    esac
    export MYSQL_PWD=$MYSQL_ROOT_PASSWORD
    mysql -u root -e "DROP DATABASE IF EXISTS \`$MYSQL_DATABASE\`;
        CREATE DATABASE \`$MYSQL_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;" &&
    exec mysql -u root --default-character-set=utf8mb4 "$MYSQL_DATABASE"
'; then
    printf 'restore: loading the backup FAILED. The app and worker are still stopped.\n' >&2
    if [ "$SAFETY_BACKUP" = true ]; then
        printf 'restore: the previous database was saved as a "pre-restore" backup in %s;\n' \
            "${BACKUP_DIR:-$(dirname -- "$FILE")}" >&2
        printf 'restore: restore that file to go back.\n' >&2
    fi
    exit 1
fi

restart
log "done. The app applies any newer migrations as it starts: docker compose logs -f app"

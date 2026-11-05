#!/bin/sh
# End-to-end test of backup.sh and restore.sh against a real MySQL 8.4 container.
#
#   deploy/scripts/test/backup-restore.test.sh
#
# Needs Docker with the compose plugin. It starts a throwaway compose project (a db
# service like the real one, plus a stand-in "app" service), and removes it afterwards.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SCRIPTS=$(dirname -- "$HERE")
WORK=$(mktemp -d)
PROJECT="hb-backup-test-$$"
FAILED=0

cleanup() {
    docker compose --project-directory "$WORK/stack" -f "$WORK/stack/docker-compose.yml" \
        down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf -- "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

pass() { printf 'ok   - %s\n' "$*"; }
not_ok() {
    printf 'FAIL - %s\n' "$*"
    FAILED=1
}

mkdir -p "$WORK/stack" "$WORK/backups"
cat >"$WORK/stack/docker-compose.yml" <<EOF
name: $PROJECT
services:
  db:
    image: mysql:8.4
    environment:
      MYSQL_DATABASE: homebuilder
      MYSQL_USER: homebuilder
      MYSQL_PASSWORD: \${DATABASE_PASSWORD}
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
    healthcheck:
      test: ['CMD-SHELL', 'MYSQL_PWD="\$\$MYSQL_ROOT_PASSWORD" mysqladmin ping -h 127.0.0.1 -u root --silent']
      interval: 2s
      timeout: 5s
      retries: 60
  app:
    # Stands in for the real app: restore.sh must stop and restart it.
    image: mysql:8.4
    entrypoint: ['sleep', 'infinity']
EOF
cat >"$WORK/stack/.env" <<EOF
APPDATA_DIR=$WORK/appdata
DATABASE_PASSWORD=test-app-password
MYSQL_ROOT_PASSWORD=test-root-password
EOF

compose() {
    docker compose --project-directory "$WORK/stack" -f "$WORK/stack/docker-compose.yml" "$@"
}

sql() {
    # shellcheck disable=SC2016
    compose exec -T db sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD exec mysql -u root -N -B homebuilder'
}

echo "# starting MySQL"
if ! output=$(compose up -d --wait db app 2>&1); then
    printf '%s\n' "$output" >&2
    echo "FAIL - could not start the test stack" >&2
    exit 1
fi

sql <<'SQL'
CREATE TABLE kysely_migration (name VARCHAR(255) PRIMARY KEY, timestamp VARCHAR(255) NOT NULL);
INSERT INTO kysely_migration VALUES ('0001_initial_schema', '2026-01-01');
CREATE TABLE videos (id INT PRIMARY KEY, title VARCHAR(200) CHARACTER SET utf8mb4);
INSERT INTO videos VALUES (1, 'Insulating a garage door'), (2, 'Ünïcode ✓ water heater');
SQL

# --- backup ---------------------------------------------------------------------------------
"$SCRIPTS/backup.sh" -d "$WORK/stack" -o "$WORK/backups" >/dev/null
BACKUP=$(find "$WORK/backups" -name 'homebuilder-*.sql.gz' | head -n 1)
if [ -n "$BACKUP" ] && gzip -t "$BACKUP"; then pass "backup.sh writes a valid gzip file"; else not_ok "no backup written"; fi
mode=$(stat -c %a "$BACKUP")
if [ "$mode" = 600 ]; then pass "the backup is readable by its owner only"; else not_ok "backup mode is $mode"; fi
if [ -z "$(find "$WORK/backups" -name '.*')" ]; then pass "no temporary files are left behind"; else not_ok "temporary files left"; fi
if gzip -dc "$BACKUP" | grep -q 'test-root-password'; then not_ok "the password leaked into the dump"; else pass "the dump holds no password"; fi

# Default location: APPDATA_DIR from .env, plus /backups.
"$SCRIPTS/backup.sh" -d "$WORK/stack" >/dev/null
if [ -n "$(find "$WORK/appdata/backups" -name 'homebuilder-*.sql.gz')" ]; then
    pass "backups default to APPDATA_DIR/backups"
else
    not_ok "default backup location not used"
fi

# Pruning: an old backup is removed, the new one and unrelated files are kept.
touch -t 202001010000 "$WORK/backups/homebuilder-20200101-000000.sql.gz" "$WORK/backups/notes.txt"
"$SCRIPTS/backup.sh" -d "$WORK/stack" -o "$WORK/backups" -k 7 -l nightly >/dev/null
if [ ! -e "$WORK/backups/homebuilder-20200101-000000.sql.gz" ] && [ -e "$WORK/backups/notes.txt" ] &&
    [ -n "$(find "$WORK/backups" -name 'homebuilder-*-nightly.sql.gz')" ]; then
    pass "-k removes only old backups"
else
    not_ok "pruning removed the wrong files"
fi

# Bad arguments are rejected before anything runs.
if "$SCRIPTS/backup.sh" -d "$WORK/stack" -k 'x' >/dev/null 2>&1; then not_ok "-k x accepted"; else pass "-k rejects non-numbers"; fi
if "$SCRIPTS/backup.sh" -d "$WORK/stack" -l 'a;b' >/dev/null 2>&1; then not_ok "-l 'a;b' accepted"; else pass "-l rejects odd characters"; fi

# --- restore --------------------------------------------------------------------------------
sql <<'SQL'
DELETE FROM videos WHERE id = 1;
UPDATE videos SET title = 'changed' WHERE id = 2;
CREATE TABLE added_later (id INT);
SQL

if "$SCRIPTS/restore.sh" -d "$WORK/stack" "$BACKUP" </dev/null >/dev/null 2>&1; then
    not_ok "restore ran without confirmation"
else
    pass "restore refuses to run unattended without -y"
fi

head -c 200 "$BACKUP" >"$WORK/truncated.sql.gz"
if "$SCRIPTS/restore.sh" -d "$WORK/stack" -y "$WORK/truncated.sql.gz" >/dev/null 2>&1; then
    not_ok "a truncated backup was restored"
else
    pass "restore rejects a truncated file"
fi

printf 'CREATE TABLE other (id INT);\n-- Dump completed on 2026-01-01\n' | gzip >"$WORK/other.sql.gz"
if "$SCRIPTS/restore.sh" -d "$WORK/stack" -y "$WORK/other.sql.gz" >/dev/null 2>&1; then
    not_ok "a non-Home Builder dump was restored"
else
    pass "restore rejects other databases' dumps"
fi
if [ "$(echo 'SELECT COUNT(*) FROM videos;' | sql)" = 1 ]; then
    pass "rejected restores change nothing"
else
    not_ok "a rejected restore changed the database"
fi

"$SCRIPTS/restore.sh" -d "$WORK/stack" -y "$BACKUP" >/dev/null
rows=$(echo 'SELECT id, title FROM videos ORDER BY id;' | sql)
expected=$(printf '1\tInsulating a garage door\n2\tÜnïcode ✓ water heater')
if [ "$rows" = "$expected" ]; then pass "restore brings back the backed-up rows"; else not_ok "restored rows: $rows"; fi
if [ "$(echo "SHOW TABLES LIKE 'added_later';" | sql)" = '' ]; then
    pass "tables created after the backup are gone"
else
    not_ok "added_later survived the restore"
fi
if [ -n "$(find "$WORK/backups" -name 'homebuilder-*-pre-restore.sql.gz')" ]; then
    pass "a pre-restore safety backup was taken"
else
    not_ok "no safety backup"
fi
if compose ps --status running --services | grep -qx app; then
    pass "the app is running again"
else
    not_ok "the app was not restarted"
fi
# The app user's privileges survive dropping and recreating the database.
# shellcheck disable=SC2016
if compose exec -T db sh -c 'MYSQL_PWD=$MYSQL_PASSWORD mysql -u "$MYSQL_USER" -N -B homebuilder -e "SELECT COUNT(*) FROM videos"' | grep -qx 2; then
    pass "the app user can still read the restored database"
else
    not_ok "the app user lost access"
fi

[ "$FAILED" -eq 0 ] || exit 1
echo "# all backup/restore tests passed"

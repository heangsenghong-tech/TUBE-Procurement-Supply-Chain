#!/bin/sh
# Restore the production database from a backup file made by backup.sh.
#   scripts/restore.sh deploy/backups/tube-2026-09-25_0215.dump
set -eu
[ $# -eq 1 ] && [ -s "$1" ] || { echo "Usage: $0 <backup.dump>" >&2; exit 1; }
backup="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
cd "$(dirname "$0")/../deploy"
printf 'This REPLACES all current data with %s. Type RESTORE to continue: ' "$backup"
read -r answer
[ "$answer" = "RESTORE" ] || { echo "Cancelled."; exit 1; }
docker compose stop app
docker compose exec -T db psql -U tube -d postgres -c "drop database if exists tube_restore_old" >/dev/null
docker compose exec -T db psql -U tube -d postgres -c "alter database tube rename to tube_restore_old"
docker compose exec -T db psql -U tube -d postgres -c "create database tube owner tube"
docker compose exec -T db pg_restore -U tube -d tube --no-owner < "$backup"
docker compose start app
echo "Restored. The previous data is kept as database 'tube_restore_old' until you drop it."

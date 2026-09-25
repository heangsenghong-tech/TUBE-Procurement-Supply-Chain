#!/bin/sh
# Daily backup of the production database (keeps 30 days). Schedule with cron, e.g.:
#   15 2 * * *  /opt/tube-procurement/scripts/backup.sh >> /var/log/tube-backup.log 2>&1
# Copy deploy/backups/ off the server too (another disk, NAS or cloud storage).
set -eu
cd "$(dirname "$0")/../deploy"
mkdir -p backups
file="backups/tube-$(date +%Y-%m-%d_%H%M).dump"
docker compose exec -T db pg_dump -U tube -d tube --format=custom > "$file"
test -s "$file" || { echo "Backup is empty: $file" >&2; rm -f "$file"; exit 1; }
find backups -name 'tube-*.dump' -mtime +30 -delete
echo "Backup written: $file ($(du -h "$file" | cut -f1))"

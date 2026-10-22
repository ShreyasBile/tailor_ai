#!/usr/bin/env bash
# Local infrastructure without Docker.
#
# Runs Postgres, Redis and MinIO directly inside WSL2 Ubuntu. Used when Docker
# Desktop is unavailable — WSL2 relays localhost, so services bound to 0.0.0.0
# here are reachable from Windows on 127.0.0.1 exactly as the compose stack
# would be. Same ports, same credentials, so no application config changes.
#
#   wsl -u root -- bash scripts/wsl-infra.sh   (from the repo root) up|down|status

set -uo pipefail

PG_USER="tailorai"
PG_PASS="tailorai_dev_password"
PG_DB="tailorai"
PG_VERSION="16"

# Data lives on D: alongside everything else — C: is short on space.
DATA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.data"
MINIO_DATA="${DATA_ROOT}/minio"
MINIO_USER="tailorai"
MINIO_PASS="tailorai_dev_secret"
S3_BUCKET="tailorai"
LOG_DIR="${DATA_ROOT}/logs"

mkdir -p "$MINIO_DATA" "$LOG_DIR"

start_keepalive() {
  # WSL2 shuts the distro down once nothing is holding it open, which takes
  # Postgres and Redis with it and leaves the API failing with P1001. A single
  # idle process keeps the VM alive for as long as the stack needs it.
  if ! pgrep -f "tailorai-keepalive" > /dev/null; then
    nohup bash -c 'exec -a tailorai-keepalive sleep infinity' > /dev/null 2>&1 &
    echo "-- keepalive --"
    echo "   holding WSL VM open"
  fi
}

start_postgres() {
  echo "-- postgres --"
  local conf="/etc/postgresql/${PG_VERSION}/main/postgresql.conf"
  local hba="/etc/postgresql/${PG_VERSION}/main/pg_hba.conf"

  # Listen on all interfaces so Windows can reach it through the WSL relay.
  sed -i "s/^#\?listen_addresses.*/listen_addresses = '*'/" "$conf"

  # Allow password auth from any address on the WSL bridge.
  if ! grep -q "tailorai-local" "$hba"; then
    echo "host all all 0.0.0.0/0 md5   # tailorai-local" >> "$hba"
    echo "host all all ::/0      md5   # tailorai-local" >> "$hba"
  fi

  pg_ctlcluster "$PG_VERSION" main start 2>/dev/null || true
  sleep 2

  if ! pg_isready -q; then
    echo "   postgres failed to start"
    return 1
  fi

  # Idempotent role + database creation.
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'\"" \
    | grep -q 1 || \
    su postgres -c "psql -q -c \"CREATE ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASS}' SUPERUSER\""

  su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${PG_DB}'\"" \
    | grep -q 1 || \
    su postgres -c "createdb -O ${PG_USER} ${PG_DB}"

  echo "   ready on 5432 (${PG_DB})"
}

start_redis() {
  echo "-- redis --"
  local conf="/etc/redis/redis.conf"
  sed -i "s/^bind .*/bind 0.0.0.0 ::/" "$conf"
  sed -i "s/^protected-mode .*/protected-mode no/" "$conf"
  # Queue entries must survive a restart.
  sed -i "s/^appendonly .*/appendonly yes/" "$conf"

  redis-server "$conf" --daemonize yes 2>/dev/null || true
  sleep 1

  if redis-cli ping 2>/dev/null | grep -q PONG; then
    echo "   ready on 6379"
  else
    echo "   redis failed to start"
    return 1
  fi
}

start_minio() {
  echo "-- minio --"
  if pgrep -x minio > /dev/null; then
    echo "   already running"
  else
    MINIO_ROOT_USER="$MINIO_USER" MINIO_ROOT_PASSWORD="$MINIO_PASS" \
      nohup /usr/local/bin/minio server "$MINIO_DATA" \
        --address ":9000" --console-address ":9001" \
        > "${LOG_DIR}/minio.log" 2>&1 &
    sleep 5
  fi

  # Bucket is created private. All access is via short-lived presigned URLs.
  /usr/local/bin/mc alias set local http://127.0.0.1:9000 "$MINIO_USER" "$MINIO_PASS" \
    > /dev/null 2>&1
  /usr/local/bin/mc mb --ignore-existing "local/${S3_BUCKET}" > /dev/null 2>&1
  /usr/local/bin/mc anonymous set none "local/${S3_BUCKET}" > /dev/null 2>&1

  if /usr/local/bin/mc ls local > /dev/null 2>&1; then
    echo "   ready on 9000 (console 9001), bucket '${S3_BUCKET}' private"
  else
    echo "   minio failed to start — see ${LOG_DIR}/minio.log"
    return 1
  fi
}

status() {
  echo "-- status --"
  pg_isready -q && echo "   postgres  UP" || echo "   postgres  DOWN"
  redis-cli ping 2>/dev/null | grep -q PONG && echo "   redis     UP" || echo "   redis     DOWN"
  pgrep -x minio > /dev/null && echo "   minio     UP" || echo "   minio     DOWN"
}

case "${1:-up}" in
  up)
    start_keepalive
    start_postgres && start_redis && start_minio
    echo ""
    status
    ;;
  # MinIO can run natively on Windows instead — WSL2's localhost relay only
  # serves the host, so a phone on the LAN cannot reach it here.
  up-nominio)
    start_keepalive
    start_postgres && start_redis
    echo ""
    status
    ;;
  down)
    pg_ctlcluster "$PG_VERSION" main stop 2>/dev/null || true
    # Ubuntu's redis package runs it under systemd with Restart=always, so a
    # bare `redis-cli shutdown` is undone at once. Stop the unit when there is one.
    if systemctl is-active --quiet redis-server 2>/dev/null; then
      systemctl stop redis-server 2>/dev/null || true
    fi
    redis-cli shutdown nosave 2>/dev/null || true
    pkill -x minio 2>/dev/null || true
    pkill -f tailorai-keepalive 2>/dev/null || true
    echo "stopped"
    ;;
  status)
    status
    ;;
  *)
    echo "usage: $0 up|down|status"
    exit 1
    ;;
esac

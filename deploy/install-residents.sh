#!/usr/bin/env bash
# install-residents.sh — stand the KAX City residents up as durable systemd
# units on Oracle (#413). Idempotent: safe to re-run after a deploy.
#
# Prerequisites (the operator's one-time steps, because they need a human):
#   - Agent-Kax checked out at /home/opc/Agent-Kax with node installed.
#   - /home/opc/.kax/resident.env populated (NATS creds, URLs) 0600.
#   - one token per agent minted from the operator's KAX session into
#     /home/opc/.kax/<agent-id>.jwt (0600). The daemon refreshes it thereafter;
#     an EXPIRED token cannot refresh, so mint fresh ones right before enabling.
#
# Usage:  sudo ./install-residents.sh 0xSCADA-QE flaukowski kannaka
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo"; exit 1; fi
if [ "$#" -eq 0 ]; then echo "usage: $0 <agent-id> [<agent-id> ...]"; exit 1; fi

HERE="$(cd "$(dirname "$0")" && pwd)"
install -d -o opc -g opc /home/opc/.kax
install -m 0644 "$HERE/kax-resident@.service" /etc/systemd/system/kax-resident@.service

if [ ! -f /home/opc/.kax/resident.env ]; then
  echo "WARNING: /home/opc/.kax/resident.env is missing — units will start deaf."
  echo "         Populate it (NATS_USER/NATS_PASSWORD/KANNAKA_NATS_URL/KAX_BASE_URL) 0600 first."
fi

systemctl daemon-reload
for agent in "$@"; do
  if [ ! -f "/home/opc/.kax/${agent}.jwt" ]; then
    echo "WARNING: /home/opc/.kax/${agent}.jwt is missing — mint one from the KAX session before enabling ${agent}."
    continue
  fi
  chmod 0600 "/home/opc/.kax/${agent}.jwt" || true
  systemctl enable --now "kax-resident@${agent}"
  echo "enabled kax-resident@${agent} — $(systemctl is-active "kax-resident@${agent}")"
done

echo "done. Follow one with: journalctl -u kax-resident@<agent-id> -f"

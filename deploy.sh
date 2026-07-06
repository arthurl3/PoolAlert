#!/usr/bin/env bash
# Deploiement de PoolAlert depuis le PC vers le Raspberry Pi, via SSH.
# A lancer depuis le dossier du depot, sur le PC (Git Bash sous Windows).
#
# Usage :
#   bash deploy.sh                 # cible par defaut : irae@RaspberryAP
#   bash deploy.sh irae@192.168.1.50
#
# Fait : stoppe le service -> transfere les fichiers (dont poolalert.env) ->
#        npm install -> (re)installe/redemarre le service -> affiche le statut.
set -euo pipefail

HOST="${1:-${POOLALERT_HOST:-irae@RaspberryAP}}"
DEST="/home/irae/poolalert"

cd "$(dirname "$0")"

if [ ! -f poolalert.env ]; then
  echo "❌ poolalert.env introuvable en local." >&2
  echo "   Cree-le :  cp poolalert.env.example poolalert.env  puis renseigne ton token." >&2
  exit 1
fi

# Fichiers transferes (poolalert.env inclus -> les secrets arrivent sur le Pi sans passer par git)
FILES="Pool_Alert.js package.json alarm.wav abis poolalert.env run.sh install-service.sh poolalert.env.example RASPBERRY.md"

echo "==> [1/4] Arret du service + preparation du dossier sur $HOST"
ssh "$HOST" "sudo systemctl stop poolalert 2>/dev/null || true; mkdir -p '$DEST'"

echo "==> [2/4] Transfert des fichiers"
tar czf - $FILES | ssh "$HOST" "cd '$DEST' && tar xzf -"

echo "==> [3/4] npm install + (re)installation du service"
ssh "$HOST" "cd '$DEST' && npm install --omit=dev && if systemctl list-unit-files 2>/dev/null | grep -q '^poolalert.service'; then sudo systemctl restart poolalert; else sudo bash install-service.sh; fi"

echo "==> [4/4] Statut"
ssh "$HOST" "echo -n 'is-active:  '; systemctl is-active poolalert; echo -n 'is-enabled: '; systemctl is-enabled poolalert; echo '--- derniers logs ---'; tail -n 15 '$DEST/service.log' 2>/dev/null || true"

echo ""
echo "✅ Deploiement termine sur $HOST."

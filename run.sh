#!/usr/bin/env bash
# Lancement manuel de PoolAlert (utile pour tester sur le Raspberry).
# Pour un fonctionnement 24/7 (demarrage au boot + redemarrage auto), voir install-service.sh.
cd "$(dirname "$0")"

if [ -f poolalert.env ]; then
  set -a            # exporte automatiquement les variables lues
  . ./poolalert.env
  set +a
else
  echo "⚠️  poolalert.env manquant — alertes Telegram desactivees (le son reste actif)." >&2
  echo "    Cree-le :  cp poolalert.env.example poolalert.env  puis edite-le." >&2
fi

node Pool_Alert.js

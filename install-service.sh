#!/usr/bin/env bash
# Installe PoolAlert comme service systemd sur le Raspberry Pi :
#   - demarre automatiquement au boot (crucial apres une coupure de courant)
#   - redemarre tout seul en cas de crash (avec garde anti-boucle)
# Usage :  sudo bash install-service.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_USER="${SUDO_USER:-$(whoami)}"

if [ "$(id -u)" -ne 0 ]; then
  echo "❌ A lancer avec sudo :  sudo bash install-service.sh" >&2
  exit 1
fi

# Localise node (gere nvm / PATH utilisateur ; systemd a besoin du chemin absolu)
NODE_BIN="$(sudo -u "$RUN_USER" bash -lc 'command -v node' 2>/dev/null || true)"
[ -z "$NODE_BIN" ] && NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "❌ node introuvable. Installe Node.js d'abord (voir RASPBERRY.md)." >&2
  exit 1
fi

if [ ! -f "$DIR/poolalert.env" ]; then
  echo "❌ $DIR/poolalert.env manquant." >&2
  echo "   Cree-le :  cp poolalert.env.example poolalert.env  puis mets ton token." >&2
  exit 1
fi

SERVICE=/etc/systemd/system/poolalert.service
echo "Ecriture de $SERVICE"
echo "  user=$RUN_USER  dir=$DIR  node=$NODE_BIN"
cat > "$SERVICE" <<EOF
[Unit]
Description=PoolAlert - surveillance des positions LP (alertes Telegram + son)
After=network-online.target
Wants=network-online.target
# Garde anti-boucle : max 5 redemarrages en 10 min
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$DIR
EnvironmentFile=$DIR/poolalert.env
ExecStart=$NODE_BIN $DIR/Pool_Alert.js
Restart=always
RestartSec=30
StandardOutput=append:$DIR/service.log
StandardError=append:$DIR/service.log

[Install]
WantedBy=multi-user.target
EOF

# Rotation des logs (evite que service.log gonfle la carte SD).
# copytruncate : le service garde son descripteur ouvert, pas besoin de le redemarrer.
# su root root : le fichier service.log est cree par systemd en tant que root (append:),
#   donc logrotate doit operer en root pour pouvoir le tronquer.
LOGROTATE=/etc/logrotate.d/poolalert
echo "Ecriture de $LOGROTATE"
cat > "$LOGROTATE" <<EOF
$DIR/service.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su root root
}
EOF

systemctl daemon-reload
systemctl enable poolalert.service
systemctl restart poolalert.service

echo ""
echo "✅ Service installe et demarre."
echo "   Statut  :  systemctl status poolalert --no-pager"
echo "   Logs    :  tail -f $DIR/service.log    (rotation quotidienne, 7 jours ; ou  journalctl -u poolalert -f)"
echo "   Stop    :  sudo systemctl stop poolalert"

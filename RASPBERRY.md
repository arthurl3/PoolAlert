# Installation — PoolAlert sur Raspberry Pi

Installe **PoolAlert**, un script Node.js qui surveille des positions de liquidité (LP)
sur **Hyperliquid EVM** (Ramses / Gliquid / PRJX) et envoie une **alerte Telegram** (+ son)
quand une position sort de son range — ou s'en approche (alerte anticipée réglable).
Il tourne en continu comme service `systemd` et se relance seul au boot et après un crash.

Cible : **Raspberry Pi OS** (Debian), accès SSH, utilisateur `irae`.

## Paramètres de référence

| Élément | Valeur |
|---|---|
| Utilisateur système | `irae` |
| Dossier d'installation | `/home/irae/poolalert` |
| Point d'entrée | `node Pool_Alert.js` |
| Service systemd | `poolalert` |
| Fichier de log | `/home/irae/poolalert/service.log` |
| Node.js | 18+ (testé en 20) |

## Fichiers du projet à déployer

Vers `/home/irae/poolalert/` :

```
Pool_Alert.js  package.json  alarm.wav  abis/  poolalert.env
run.sh  install-service.sh  poolalert.env.example
```

> ⚠️ `poolalert.env` contient des secrets (token Telegram, chat_id). Il doit être **copié
> depuis la sauvegarde existante**, jamais recréé de mémoire ni publié. S'il n'existe pas,
> le générer à partir de `poolalert.env.example`.

---

## Option A — Déploiement automatique depuis le PC (recommandé)

Prérequis (une seule fois) : Node.js installé sur le Pi → voir **Option B, étape 1**.

Depuis le dossier du dépôt, sur ton PC (Git Bash) :

```bash
bash deploy.sh                    # cible par défaut : irae@RaspberryAP
# ou en précisant l'IP :
bash deploy.sh irae@192.168.1.50
```

`deploy.sh` stoppe le service, transfère les fichiers (dont `poolalert.env`), lance
`npm install`, installe le service au premier passage puis le redémarre, et affiche le statut.

> Nécessite un `sudo` **sans mot de passe** pour `irae` (config par défaut de Raspberry Pi OS).
> Sinon, fais l'étape 6 de l'option B manuellement sur le Pi.

---

## Option B — Installation manuelle sur le Pi

### 1. Node.js (>= 18)

Les dépôts Raspberry Pi OS sont souvent trop vieux → NodeSource :

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version        # >= v18
```

(Optionnel, pour le son : `sudo apt install -y alsa-utils mpg123`)

### 2. Récupérer le code

```bash
mkdir -p /home/irae/poolalert
# git clone <URL> /home/irae/poolalert
# ou transfert depuis le PC :
#   tar czf - Pool_Alert.js package.json alarm.wav abis poolalert.env \
#       run.sh install-service.sh poolalert.env.example \
#     | ssh irae@RaspberryAP "cd ~/poolalert && tar xzf -"
```

### 3. Dépendances

```bash
cd /home/irae/poolalert
npm install
```

### 4. Configuration `poolalert.env`

Si `poolalert.env` a été transféré, passer cette étape. Sinon :

```bash
cp poolalert.env.example poolalert.env
nano poolalert.env        # renseigne TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID
```

### 5. Test manuel avant le service

```bash
cd /home/irae/poolalert
bash run.sh
```

Attendu : un message Telegram « 🟢 PoolAlert démarré », puis dans le terminal des lignes
`✅ ... in range` / `🟠 ... PROCHE DU BORD` / `⚠️ ... HORS RANGE` toutes les ~30 s. `Ctrl+C` pour couper.

### 6. Installer le service systemd

```bash
sudo bash install-service.sh
```

Le script écrit `/etc/systemd/system/poolalert.service`, l'active (**enable** = démarrage au
boot) et le démarre.

---

## Vérification finale (installation réussie si TOUT est vert)

```bash
systemctl is-active poolalert       # -> active
systemctl is-enabled poolalert      # -> enabled
systemctl status poolalert --no-pager | head -12
tail -20 /home/irae/poolalert/service.log
```

Critères de succès :
- `is-active` = **active**
- `is-enabled` = **enabled** (sinon PAS de redémarrage après une coupure de courant)
- le log montre des cycles récents (`in range` / `PROCHE DU BORD` / `HORS RANGE`)
- un message Telegram « 🟢 PoolAlert démarré » a été reçu

## Dépannage

| Symptôme | Cause probable | Action |
|---|---|---|
| Service `failed`, log `poolalert.env manquant` | config absente | `cp poolalert.env.example poolalert.env` puis éditer |
| `Error: Cannot find module 'ethers'` | dépendances non installées | refaire l'étape 3 (`npm install`) |
| `node introuvable` à l'install | Node.js absent | refaire l'étape 1 (NodeSource) |
| Pas d'alerte Telegram | token/chat_id vides ou faux | vérifier `poolalert.env` (bot via @BotFather, chat_id via getUpdates) |
| `could not coalesce error` / RPC | RPC Hyperliquid injoignable | vérifier la connexion réseau ; le service réessaie tout seul |
| Ne redémarre pas après reboot | service pas `enabled` | `sudo systemctl enable poolalert` |
| Pas de son | Pi headless / pas de haut-parleur | normal — Telegram reste le canal principal |

## Redéploiement rapide (mise à jour du code)

Après avoir modifié le code sur le PC, relance simplement depuis le dépôt :

```bash
bash deploy.sh
```

Il stoppe le service, renvoie les fichiers, met à jour les dépendances et redémarre.

## Réglages

- **Seuil d'alerte anticipée** : dans `poolalert.env`, décommente `WARN_MARGIN_PCT=0.2`
  (ex. 20 % du range près des bords). Défaut : 0.15 (15 %).
- **Wallets / pools surveillés** : dans `Pool_Alert.js` (tableau `protocols`).

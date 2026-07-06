const { ethers } = require("ethers");
const player = require('play-sound')({});
const provider = new ethers.JsonRpcProvider("https://rpc.hyperliquid.xyz/evm");

// Wallets surveillés
const WALLET_MAIN = "0x9014C0Aa041d637ed64d022BF237112a6B550532";
const WALLET_PRJX = "0x570cAeC87aE27b440b79D49512C3a42581dA7e5A";

const protocols = [
    {
        name: "Ramses",
        wallets: [WALLET_MAIN],
        positionManager: "0x486EC4dda7fEB9871eEF0d6ccc0D79dD3f7af7a4",
        positionManagerAbi: require("./abis/NonfungiblePositionManager.json"),
        poolAbi: require("./abis/UniswapV3Pool.json"),
        pools: [
            "0x92e802d2a0633cfca251f22016683cfeb096a28f"
        ]
    },
    {
    name: "Gliquid",
    wallets: [WALLET_MAIN],
    positionManager: "0x69D57B9D705eaD73a5d2f2476C30c55bD755cc2F",
    positionManagerAbi: require("./abis/NonfungiblePositionManager.json"),
    poolAbi: require("./abis/UniswapV3Pool.json"),
    pools: [
        "0xfbb38328df94634da1026cb7734e75e42561db5b"
    ]
},
    {
    name: "PRJX",
    wallets: [WALLET_PRJX],
    positionManager: "0xeaD19AE861c29bBb2101E834922B2FEee69B9091",
    positionManagerAbi: require("./abis/PrjxPositionManager.json"),
    poolAbi: require("./abis/UniswapV3Pool.json"),
    pools: [
        "0x467364bd2a633208b4534f5b7ec11d24604546e4" // KHYPE/UBTC 0.3%
    ]
}
];


let audioProcess = null;
let alarmActive = false;

// Démarre l'alarme sonore en boucle (idempotent : plusieurs appels ne cumulent pas)
function startAlarm() {
    if (alarmActive) return;
    alarmActive = true;
    loopAlarm();
}

async function loopAlarm() {
    while (alarmActive) {
        audioProcess = player.play('./alarm.wav', (err) => {
            if (err && !err.killed) console.error(err);
        });
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}

// Stoppe l'alarme sonore
function stopAlarm() {
    alarmActive = false;
    if (audioProcess) {
        audioProcess.kill();
        audioProcess = null;
    }
}

// === Réglages des alertes ===
// Marge d'alerte anticipée : fraction de la largeur du range près de chaque bord.
// Ex: 0.05 => alerte "bientôt hors range" quand le tick entre dans les 5% exterieurs du range
// (pres d'un des deux bords), ce qui te laisse le temps de reagir avant d'etre hors range.
// Mets 0 pour désactiver l'alerte anticipée (uniquement hors range).
// Réglable aussi via la variable d'environnement WARN_MARGIN_PCT.
const WARN_MARGIN_PCT = process.env.WARN_MARGIN_PCT !== undefined ? Number(process.env.WARN_MARGIN_PCT) : 0.05;

// Notifier aussi le retour "in range" après une alerte ?
const NOTIFY_BACK_IN_RANGE = true;

// === Config Telegram ===
// Recommandé : définir les variables d'environnement TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
// (évite de committer un secret). Sinon, colle-les directement entre les guillemets ci-dessous.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || "";

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ Telegram non configuré (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — alertes Telegram désactivées, le son reste actif.");
}

async function sendTelegram(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text,
                parse_mode: "HTML",
                disable_web_page_preview: true
            })
        });
        if (!res.ok) {
            console.warn(`Telegram sendMessage a échoué (${res.status}): ${await res.text()}`);
        }
    } catch (err) {
        console.warn(`Erreur envoi Telegram: ${err.message}`);
    }
}

// Classe une position selon le tick courant : 'out' (hors range), 'warn' (proche d'un bord), 'in' (ok)
function classifyPosition(currentTick, tickLower, tickUpper) {
    const cur = Number(currentTick);
    const lo = Number(tickLower);
    const hi = Number(tickUpper);
    if (cur < lo || cur > hi) return 'out';
    const margin = (hi - lo) * WARN_MARGIN_PCT;
    if (WARN_MARGIN_PCT > 0 && (cur <= lo + margin || cur >= hi - margin)) return 'warn';
    return 'in';
}

// Dernier état notifié par position -> n'envoie un Telegram qu'aux changements d'état
const positionStates = {};


async function getAllPositionsForProtocol(protocol) {
    const positionManager = new ethers.Contract(protocol.positionManager, protocol.positionManagerAbi, provider);

    const positions = [];

    for (const userAddress of protocol.wallets) {
        let balance;
        try {
            balance = await positionManager.balanceOf(userAddress);
        } catch (err) {
            console.warn(`[${protocol.name}] balanceOf a échoué pour ${userAddress}: ${err.message}`);
            continue;
        }

        for (let i = 0; i < balance; i++) {
            try {
                const tokenId = await positionManager.tokenOfOwnerByIndex(userAddress, i);
                let pos;
                try {
                    pos = await positionManager.positions(tokenId);
                } catch {
                    pos = null;
                }

                if(pos && BigInt(pos.liquidity) > 0n && pos.token0 != '0x0000000000000000000000000000000000000000' && pos.token1 != '0x0000000000000000000000000000000000000000')
                {
                    positions.push({
                            wallet: userAddress,
                            tokenId: tokenId.toString(),
                            pools: protocol.pools,
                            token0: pos?.token0 || null,
                            token1: pos?.token1 || null,
                            tickLower: pos?.tickLower?.toString() || null,
                            tickUpper: pos?.tickUpper?.toString() || null,
                            liquidity: pos?.liquidity?.toString() || null
                        });
                }
            }
            catch (err) {
                    console.warn(`[${protocol.name}] Erreur avec l'index ${i} (${userAddress}): ${err.message}`);
            }
        }
    }

    return positions;
}

async function monitorAllProtocols() {
    let anyOutOfRange = false;

    for (const protocol of protocols) {
        const positions = await getAllPositionsForProtocol(protocol);

        for (const pos of positions) {


            for (const poolAddress of pos.pools) {

                try {
                    const poolContract = new ethers.Contract(poolAddress, protocol.poolAbi, provider);
                    const slot0 = await poolContract.slot0();
                    const currentTick = Number(slot0.tick);

                    const state = classifyPosition(currentTick, pos.tickLower, pos.tickUpper);
                    const key = `${protocol.name}-${pos.tokenId}`;
                    const prev = positionStates[key];

                    const label = `[${protocol.name}] Wallet ${pos.wallet} - Position ${pos.tokenId}`;
                    const range = `range [${pos.tickLower}, ${pos.tickUpper}], tick actuel ${currentTick}`;

                    if (state === 'out') {
                        anyOutOfRange = true;
                        console.log(`⚠️ ${label} HORS RANGE (${range})`);
                    } else if (state === 'warn') {
                        console.log(`🟠 ${label} PROCHE DU BORD (${range})`);
                    } else {
                        console.log(`✅ ${label} in range (${range})`);
                    }

                    // Telegram : uniquement au changement d'état (évite le spam toutes les 30s)
                    if (state !== prev) {
                        if (state === 'out') {
                            await sendTelegram(`⚠️ <b>HORS RANGE</b>\n${label}\n${range}`);
                        } else if (state === 'warn') {
                            await sendTelegram(`🟠 <b>Bientôt hors range</b>\n${label}\n${range}`);
                        } else if (state === 'in' && NOTIFY_BACK_IN_RANGE && (prev === 'out' || prev === 'warn')) {
                            await sendTelegram(`✅ <b>De nouveau in range</b>\n${label}\n${range}`);
                        }
                    }

                    positionStates[key] = state;
                } catch (err) {
                    console.warn(`Impossible de récupérer le tick pour le pool ${poolAddress}: ${err.message}`);
                }
            }
        }
    }

    // Son : une seule décision par cycle (corrige le flip-flop quand plusieurs positions sont surveillées)
    if (anyOutOfRange) {
        startAlarm();
    } else {
        stopAlarm();
    }
}


sendTelegram("🟢 PoolAlert démarré — surveillance des positions en cours.").catch(() => {});
monitorAllProtocols();

// Lancement : vérification toutes les 30 secondes
setInterval(monitorAllProtocols, 30 * 1000);

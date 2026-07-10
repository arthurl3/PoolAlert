const { ethers } = require("ethers");
const player = require('play-sound')({});

// Noeuds HyperEVM essayés dans l'ordre. Le RPC officiel rate-limite durablement une IP qui a
// trop tapé — et répond alors "rate limited" même à un eth_chainId : sans secours, la
// surveillance s'arrête sans que rien ne sorte du range. RPC_URL surcharge la liste.
const DEFAULT_RPC_URLS = [
    "https://rpc.hyperliquid.xyz/evm",
    "https://rpc.purroofgroup.com",
    "https://hyperliquid.drpc.org"
];
const RPC_URLS = (process.env.RPC_URL || DEFAULT_RPC_URLS.join(","))
    .split(",")
    .map(url => url.trim())
    .filter(Boolean);

// Le réseau est déclaré en dur : sans ça ethers émet un eth_chainId à chaque requête, et
// refuse même de démarrer tant que la détection est rate-limitée.
const HYPEREVM = ethers.Network.from(999);
const providers = RPC_URLS.map(url => new ethers.JsonRpcProvider(url, HYPEREVM, { staticNetwork: HYPEREVM }));
let providerIndex = 0;

// Wallets surveillés
//const WALLET_MAIN = "0x9014C0Aa041d637ed64d022BF237112a6B550532";
const WALLET_PRJX = "0x570cAeC87aE27b440b79D49512C3a42581dA7e5A";

// Deux familles de PositionManager coexistent sur HyperEVM :
//  - NonfungiblePositionManager.json : positions() expose tickSpacing (Ramses)
//  - UniswapV3PositionManager.json   : positions() expose fee (Uniswap V3 et ses forks)
// Utiliser la mauvaise décale le décodage et fait passer les positions pour vides.
const protocols = [
    {
        // Ramses V3. L'ancien déploiement (PM 0x486EC4dd, pool 0x92e802) reposait sur une
        // autre factory et ne détient plus de liquidité : il n'est plus surveillé.
        // Ses pools indexent les positions par tokenId, cf. positionKey().
        name: "Ramses V3",
        wallets: [WALLET_PRJX],
        positionManager: "0xB3F77C5134D643483253D22E0Ca24627aE42ED51",
        positionManagerAbi: require("./abis/NonfungiblePositionManager.json"),
        poolAbi: require("./abis/UniswapV3Pool.json"),
        indexedPositions: true,
        pools: [
            "0x21092837C89A1858aA7e6631Fcf77a5F12C10218" // UBTC/UETH, tickSpacing 10
        ]
    },
    {
        name: "PRJX",
        wallets: [WALLET_PRJX],
        positionManager: "0xeaD19AE861c29bBb2101E834922B2FEee69B9091",
        positionManagerAbi: require("./abis/UniswapV3PositionManager.json"),
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


// === Lecture on-chain groupée ===
// Un PositionManager ERC-721 n'expose que balanceOf / tokenOfOwnerByIndex(i) / positions(id) :
// lire N positions demande 1 + 2N lectures, et chaque étage dépend du précédent. Multicall3
// agrège chaque étage en un seul eth_call -> ~4 requêtes par cycle quel que soit le nombre de NFT.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicallIface = new ethers.Interface([
    "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"
]);

// Un eth_call agrégé reste borné : au-delà, on découpe pour ne pas cogner la limite de gas.
const MAX_CALLS_PER_BATCH = 150;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Les erreurs ethers embarquent tout le payload (calldata compris) : illisible dans un log.
const briefly = (err) => (err.shortMessage || err.message || String(err)).split("\n")[0].slice(0, 120);

// Un noeud qui accepte la connexion sans jamais répondre bloquerait le cycle 5 minutes
// (timeout ethers par défaut), pendant que setInterval en empile d'autres derrière.
const RPC_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, label) {
    let timer;
    const expiry = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} : aucune réponse en ${ms} ms`)), ms);
    });
    return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// Une lecture on-chain, en basculant de noeud tant qu'il en reste un qui répond. Le noeud
// retenu est conservé pour les appels suivants : inutile de retomber sur celui qui rate-limite.
async function rpcCall(tx) {
    let lastErr;
    for (let attempt = 0; attempt < providers.length * 2; attempt++) {
        const current = providerIndex;
        try {
            return await withTimeout(providers[current].call(tx), RPC_TIMEOUT_MS, RPC_URLS[current]);
        } catch (err) {
            lastErr = err;
            providerIndex = (current + 1) % providers.length;
            if (providers.length > 1) {
                console.warn(`RPC ${RPC_URLS[current]} indisponible (${briefly(err)}) -> bascule sur ${RPC_URLS[providerIndex]}`);
            }
            await sleep(300 * (attempt + 1));
        }
    }
    throw new Error(`aucun RPC ne répond (${briefly(lastErr)})`);
}

const ifaceCache = new Map();
function ifaceFor(abi) {
    let iface = ifaceCache.get(abi);
    if (!iface) {
        iface = new ethers.Interface(abi);
        ifaceCache.set(abi, iface);
    }
    return iface;
}

// Exécute toutes les lectures en un minimum d'eth_call. Le résultat est aligné sur `calls`,
// avec null pour toute lecture ayant échoué (allowFailure : un revert n'annule pas les autres).
async function aggregate(calls) {
    const decoded = [];
    for (let start = 0; start < calls.length; start += MAX_CALLS_PER_BATCH) {
        const chunk = calls.slice(start, start + MAX_CALLS_PER_BATCH);
        const encoded = chunk.map(call => ({
            target: call.target,
            allowFailure: true,
            callData: call.iface.encodeFunctionData(call.fn, call.args)
        }));

        const raw = await rpcCall({
            to: MULTICALL3,
            data: multicallIface.encodeFunctionData("aggregate3", [encoded])
        });
        const [results] = multicallIface.decodeFunctionResult("aggregate3", raw);

        results.forEach((result, i) => {
            if (!result.success) return decoded.push(null);
            try {
                decoded.push(chunk[i].iface.decodeFunctionResult(chunk[i].fn, result.returnData));
            } catch {
                decoded.push(null);
            }
        });
    }
    return decoded;
}

// tickSpacing n'existe que sur les positions Ramses ; l'ABI Uniswap V3 expose fee à la place.
function optionalTickSpacing(pos) {
    try {
        return pos.tickSpacing === undefined ? null : Number(pos.tickSpacing);
    } catch {
        return null;
    }
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Lit toutes les positions ouvertes de tous les wallets, en 3 vagues de lectures groupées.
async function collectAllPositions() {
    // Vague 1 : combien de NFT détient chaque wallet ?
    const balanceCalls = protocols.flatMap(protocol =>
        protocol.wallets.map(wallet => ({
            protocol,
            wallet,
            target: protocol.positionManager,
            iface: ifaceFor(protocol.positionManagerAbi),
            fn: "balanceOf",
            args: [wallet]
        })));
    const balances = await aggregate(balanceCalls);

    // Vague 2 : le tokenId de chacun de ces NFT.
    const tokenIdCalls = [];
    balanceCalls.forEach((call, i) => {
        const balance = balances[i] ? Number(balances[i][0]) : 0;
        for (let index = 0; index < balance; index++) {
            tokenIdCalls.push({ ...call, fn: "tokenOfOwnerByIndex", args: [call.wallet, index] });
        }
    });
    const tokenIds = await aggregate(tokenIdCalls);

    // Vague 3 : le détail de chaque position.
    const positionCalls = [];
    tokenIdCalls.forEach((call, i) => {
        if (!tokenIds[i]) return;
        positionCalls.push({ ...call, tokenId: tokenIds[i][0], fn: "positions", args: [tokenIds[i][0]] });
    });
    const rawPositions = await aggregate(positionCalls);

    const positions = [];
    positionCalls.forEach((call, i) => {
        const pos = rawPositions[i];
        if (!pos) return;
        // Une position refermée garde son NFT mais n'a plus de liquidité.
        if (BigInt(pos.liquidity) === 0n) return;
        if (pos.token0 === ZERO_ADDRESS || pos.token1 === ZERO_ADDRESS) return;

        positions.push({
            protocol: call.protocol,
            wallet: call.wallet,
            tokenId: call.tokenId,
            token0: pos.token0.toLowerCase(),
            token1: pos.token1.toLowerCase(),
            tickSpacing: optionalTickSpacing(pos),
            tickLower: Number(pos.tickLower),
            tickUpper: Number(pos.tickUpper),
            liquidity: pos.liquidity
        });
    });
    return positions;
}

// Clé d'une position dans sa pool. Ramses V3 y intègre le tokenId (deux NFT peuvent
// partager un range) ; Uniswap V3 agrège au contraire les mêmes bornes sous une clé unique.
function positionKey(protocol, pos) {
    return protocol.indexedPositions
        ? ethers.solidityPackedKeccak256(
            ["address", "uint256", "int24", "int24"],
            [protocol.positionManager, pos.tokenId, pos.tickLower, pos.tickUpper])
        : ethers.solidityPackedKeccak256(
            ["address", "int24", "int24"],
            [protocol.positionManager, pos.tickLower, pos.tickUpper]);
}

// Métadonnées des pools : immuables, donc lues une seule fois.
const poolMetaCache = new Map();

async function loadPoolMetas() {
    const missing = protocols.flatMap(protocol =>
        protocol.pools
            .filter(address => !poolMetaCache.has(address))
            .map(address => ({ protocol, address })));
    if (missing.length === 0) return;

    const calls = missing.flatMap(({ protocol, address }) => {
        const iface = ifaceFor(protocol.poolAbi);
        return ["token0", "token1", "tickSpacing"].map(fn => ({ target: address, iface, fn, args: [] }));
    });
    const results = await aggregate(calls);

    missing.forEach(({ protocol, address }, i) => {
        const [token0, token1, tickSpacing] = results.slice(i * 3, i * 3 + 3);
        if (!token0 || !token1) {
            // Pas de mise en cache : un échec RPC est transitoire, le figer condamnerait la pool.
            console.warn(`[${protocol.name}] Métadonnées illisibles pour le pool ${address}`);
            return;
        }
        poolMetaCache.set(address, {
            address,
            iface: ifaceFor(protocol.poolAbi),
            token0: token0[0].toLowerCase(),
            token1: token1[0].toLowerCase(),
            // tickSpacing ne sert qu'à départager deux pools de même paire, et toutes les
            // forks ne l'exposent pas : son absence ne doit pas écarter la pool.
            tickSpacing: tickSpacing ? Number(tickSpacing[0]) : null
        });
    });
}

// Retrouve la pool qui porte réellement cette position. Sans ça, une position serait
// comparée au tick de toutes les pools du protocole -> alertes fantômes.
async function resolvePoolForPosition(protocol, pos) {
    const metas = protocol.pools.map(address => poolMetaCache.get(address)).filter(Boolean);

    let candidates = metas.filter(m => m.token0 === pos.token0 && m.token1 === pos.token1);
    if (candidates.length > 1 && pos.tickSpacing !== null) {
        const bySpacing = candidates.filter(m => m.tickSpacing === pos.tickSpacing);
        if (bySpacing.length > 0) candidates = bySpacing;
    }
    if (candidates.length <= 1) return candidates[0] || null;

    // Même paire et même tickSpacing : on demande à chaque pool si elle porte la position.
    // Le fee ne peut pas servir de discriminant, il est dynamique sur Ramses V3.
    const key = positionKey(protocol, pos);
    for (const meta of candidates) {
        try {
            const raw = await rpcCall({ to: meta.address, data: meta.iface.encodeFunctionData("positions", [key]) });
            const [liquidity] = meta.iface.decodeFunctionResult("positions", raw);
            if (BigInt(liquidity) > 0n) return meta;
        } catch (err) {
            console.warn(`[${protocol.name}] positions() a échoué sur ${meta.address}: ${briefly(err)}`);
        }
    }
    return null;
}

// Un cycle lent ne doit pas se faire doubler par le suivant : les deux liraient la chaîne en
// parallèle et écraseraient positionStates dans le désordre.
let cycleRunning = false;

async function monitorAllProtocols() {
    if (cycleRunning) {
        console.warn("Cycle précédent encore en cours, celui-ci est sauté.");
        return;
    }
    cycleRunning = true;
    try {
        await runCycle();
    } finally {
        cycleRunning = false;
    }
}

async function runCycle() {
    let positions;
    try {
        await loadPoolMetas();
        positions = await collectAllPositions();
    } catch (err) {
        // Rien n'a pu être lu : on ne sait pas où on en est, donc on ne coupe pas l'alarme.
        console.warn(`Cycle ignoré (RPC injoignable) : ${briefly(err)}`);
        return;
    }

    const monitored = [];
    for (const pos of positions) {
        const pool = await resolvePoolForPosition(pos.protocol, pos);
        if (pool) monitored.push({ pos, pool });
    }

    // Vague 4 : le tick courant de chaque pool concernée.
    const pools = [...new Map(monitored.map(m => [m.pool.address, m.pool])).values()];
    let slot0s;
    try {
        slot0s = await aggregate(pools.map(p => ({ target: p.address, iface: p.iface, fn: "slot0", args: [] })));
    } catch (err) {
        console.warn(`Cycle ignoré (slot0 illisible) : ${briefly(err)}`);
        return;
    }

    const tickByPool = new Map();
    pools.forEach((pool, i) => {
        if (slot0s[i]) tickByPool.set(pool.address, Number(slot0s[i].tick));
    });

    let anyOutOfRange = false;
    let incomplete = false;

    for (const { pos, pool } of monitored) {
        const currentTick = tickByPool.get(pool.address);
        if (currentTick === undefined) {
            // Tick inconnu : cette position n'est pas évaluée, le cycle est partiel.
            incomplete = true;
            continue;
        }

        const state = classifyPosition(currentTick, pos.tickLower, pos.tickUpper);
        const key = `${pos.protocol.name}-${pos.tokenId}`;
        const prev = positionStates[key];

        const label = `[${pos.protocol.name}] Wallet ${pos.wallet} - Position ${pos.tokenId}`;
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
    }

    // Son : une seule décision par cycle (corrige le flip-flop quand plusieurs positions sont
    // surveillées). Un cycle partiel ne coupe jamais une alarme en cours : tant qu'on n'a pas
    // relu toutes les positions, on ne peut pas affirmer qu'aucune n'est hors range.
    if (anyOutOfRange) {
        startAlarm();
    } else if (!incomplete) {
        stopAlarm();
    }
}


sendTelegram("🟢 PoolAlert démarré — surveillance des positions en cours.").catch(() => {});
monitorAllProtocols();

// Lancement : vérification toutes les 30 secondes
setInterval(monitorAllProtocols, 30 * 1000);

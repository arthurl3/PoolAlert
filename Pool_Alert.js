const { ethers } = require("ethers");
const player = require('play-sound')({});
const provider = new ethers.JsonRpcProvider("https://rpc.hyperliquid.xyz/evm");
const userAddress = "0x9014C0Aa041d637ed64d022BF237112a6B550532";
const protocols = [
    {
        name: "Ramses",
        positionManager: "0x486EC4dda7fEB9871eEF0d6ccc0D79dD3f7af7a4",
        positionManagerAbi: require("./abis/NonfungiblePositionManager.json"),
        poolAbi: require("./abis/UniswapV3Pool.json"),
        pools: [
            "0x92e802d2a0633cfca251f22016683cfeb096a28f"
        ]
    },
    {
    name: "Gliquid",
    positionManager: "0x69D57B9D705eaD73a5d2f2476C30c55bD755cc2F",
    positionManagerAbi: require("./abis/NonfungiblePositionManager.json"),
    poolAbi: require("./abis/UniswapV3Pool.json"),
    pools: [
        "0xfbb38328df94634da1026cb7734e75e42561db5b"
    ]
}
];


let  audioProcess = null; 
let isPlaying = false;
// Mettre en "pause" (en réalité, stoppe le son)
function pauseAudio() {
    if (audioProcess) {
      audioProcess.kill(); // stop le son
      isPlaying = true;
    }
  }

// Fonction asynchrone qui joue le son
async function playAudioLoop() {
    if (isPlaying) return;
    isPlaying = true;

    while (isPlaying) {
        // Lance le son
        audioProcess = player.play('./alarm.wav', (err) => {
            if (err && !err.killed) console.error(err);
        });

        // Attend la durée du son avant de relancer
        await new Promise(resolve => setTimeout(resolve, 5000)); // 1000 ms = 1s
    }
}


async function getAllPositionsForProtocol(protocol) {
    const positionManager = new ethers.Contract(protocol.positionManager, protocol.positionManagerAbi, provider);
    const balance = await positionManager.balanceOf(userAddress);

    const positions = [];

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
                console.warn(`[${protocol.name}] Erreur avec l'index ${i}: ${err.message}`);
        }
    }

    return positions;
}

async function monitorAllProtocols() {
    for (const protocol of protocols) {
        const positions = await getAllPositionsForProtocol(protocol);

        for (const pos of positions) {

            console.log(pos);
 

            for (const poolAddress of pos.pools) {

                try {
                    const poolContract = new ethers.Contract(poolAddress, protocol.poolAbi, provider);
                    const slot0 = await poolContract.slot0();
                    const currentTick = slot0.tick;

                    const inRange = currentTick >= pos.tickLower && currentTick <= pos.tickUpper;

                    if (!inRange) {
                        console.log(`⚠️ [${protocol.name}] Position ${pos.tokenId} OUT OF RANGE (tick = ${currentTick})`);
                        isPlaying = true;
                        playAudioLoop();
                    } else {
                        console.log(`✅ [${protocol.name}] Position ${pos.tokenId} is in range`);
                        isPlaying = false;
                    }
                } catch (err) {
                    console.warn(`Impossible de récupérer le tick pour le pool ${poolAddress}: ${err.message}`);
                }
            }
        }
    }
}


monitorAllProtocols();

// Lancement : vérification toutes les 30 secondes
setInterval(monitorAllProtocols, 30 * 1000);

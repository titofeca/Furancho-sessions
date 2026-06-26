require('dotenv').config();
const { ethers } = require('ethers');

// RPCs de Polygon a probar EN ORDEN. POLYGON_RPC_URL puede ser uno o varios
// separados por comas (p. ej. una clave dedicada de Alchemy/Infura primero).
// Siempre añadimos varios RPC públicos de respaldo para no depender de un único
// proveedor: 1rpc.io gratis se queda sin cuota en eventos con muchos mints
// ("usage limit reached") y entonces fallan tanto leer el saldo como mintear.
// Endpoints públicos verificados que responden bien (sin clave). polygon-rpc.com
// se deja como último recurso por compatibilidad aunque a veces limita.
const RPC_FALLBACKS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.drpc.org',
  'https://polygon-rpc.com'
];
const RPC_URLS = [
  ...((process.env.POLYGON_RPC_URL || '').split(',').map(s => s.trim()).filter(Boolean)),
  ...RPC_FALLBACKS
].filter((u, i, arr) => arr.indexOf(u) === i); // sin duplicados
const POLYGON_RPC   = RPC_URLS[0]; // compatibilidad / logs
const POLYGON_CHAIN_ID = 137; // red fija → evita la llamada eth_chainId por provider
const MINTER_KEY    = process.env.MINTER_PRIVATE_KEY;
const CONTRACT_ADDR = process.env.NFT_CONTRACT_ADDRESS;

// Crea un provider con la red fijada (menos llamadas RPC, sin "detect network").
function makeProvider(url) {
  return new ethers.JsonRpcProvider(url, POLYGON_CHAIN_ID, { staticNetwork: true });
}

// Token IDs en el contrato ERC-1155 (1-indexed: 1=Cautivo, 2=Cunqueiro, 3=Larpeiro, 4=Presidente)
const TOKEN_IDS = { 1: 1, 2: 2, 3: 3, 4: 4 };

// ABI mínimo del contrato FuranchoNFT
const ABI = [
  'function mint(address to, uint256 tokenId, uint256 amount) external',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)'
];

const DEMO_MODE = process.env.DEMO_MODE === 'true'
  || !MINTER_KEY
  || !CONTRACT_ADDR
  || MINTER_KEY === 'your_minter_private_key_here';

if (DEMO_MODE && process.env.DEMO_MODE !== 'true') {
  console.warn('[Polygon] ⚠️  DEMO_MODE activo por keys ausentes — MINTER_PRIVATE_KEY o NFT_CONTRACT_ADDRESS no configuradas. Los mints Nv3/Nv4 serán simulados hasta que las añadas en Railway.');
} else if (!DEMO_MODE) {
  console.log(`[Polygon] ✅ Modo producción Polygon activo — los mints Nv3/Nv4 van a la blockchain real. RPCs con respaldo: ${RPC_URLS.length}`);
}

// Evita que un RPC caído/colgado nos deje esperando para siempre.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout RPC ${label || ''} (${ms}ms)`)), ms))
  ]);
}

// Ejecuta fn(provider) probando cada RPC en orden hasta que uno responda.
// Para LECTURAS (saldo, balance on-chain, receipts) reintentar en otro RPC es seguro.
async function withProvider(fn, timeoutMs = 8000) {
  let lastErr;
  for (const url of RPC_URLS) {
    try {
      const provider = makeProvider(url);
      return await withTimeout(fn(provider), timeoutMs, url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Ningún RPC de Polygon respondió');
}

// Devuelve un signer sobre el PRIMER RPC que responde a un ping de salud.
// Para ENVIAR el mint: así no intentamos firmar/enviar contra un RPC caído o
// rate-limitado. Si el envío fallara después, el mint queda 'failed' y se recupera
// con el backfill (comprueba el saldo on-chain antes de regastar gas).
async function getHealthySigner() {
  let lastErr;
  for (const url of RPC_URLS) {
    try {
      const provider = makeProvider(url);
      await withTimeout(provider.getBlockNumber(), 4000, url); // ping de salud
      return new ethers.Wallet(MINTER_KEY, provider);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Ningún RPC de Polygon respondió');
}

// Mintea por nivel (1-4) o por tokenId directo (logros, token >= 100). Si se pasa
// `tokenId` tiene prioridad; si no, se resuelve desde el nivel.
async function mintNFT({ walletAddress, level, levelName, tokenId }) {
  const id = (tokenId != null) ? tokenId : TOKEN_IDS[level];

  if (DEMO_MODE) {
    console.log(`[DEMO] Minting NFT token ${id} (${levelName || 'logro'}) → ${walletAddress}`);
    await new Promise(r => setTimeout(r, 1200));
    return {
      success: true,
      txHash: `demo_${Date.now()}`,
      walletAddress,
      demo: true
    };
  }

  if (id == null) throw new Error(`Token ID no configurado (level=${level}, tokenId=${tokenId})`);

  const signer   = await getHealthySigner();
  const contract = new ethers.Contract(CONTRACT_ADDR, ABI, signer);

  console.log(`[Polygon] Minting token ${id} → ${walletAddress}`);

  const tx = await contract.mint(walletAddress, id, 1);
  const receipt = await tx.wait();

  const gasUsed = receipt.gasUsed || 0n;
  const gasPrice = receipt.gasPrice || tx.gasPrice || 0n;
  const costMatic = parseFloat(ethers.formatEther(gasUsed * gasPrice));

  console.log(`[Polygon] ✅ TX confirmada: ${receipt.hash} — coste: ${costMatic.toFixed(6)} MATIC`);
  return {
    success: true,
    txHash: receipt.hash,
    walletAddress,
    costMatic,
    demo: false
  };
}

// Saldo de la billetera que paga el gas de los mints (POL/MATIC en Polygon).
// Devuelve { demo, address, balance } — en DEMO_MODE no hay billetera real.
async function getMinterBalance() {
  if (DEMO_MODE) {
    return { demo: true, address: null, balance: null };
  }
  return withProvider(async (provider) => {
    const wallet = new ethers.Wallet(MINTER_KEY, provider);
    const balanceWei = await provider.getBalance(wallet.address);
    return {
      demo: false,
      address: wallet.address,
      balance: parseFloat(ethers.formatEther(balanceWei))
    };
  });
}

// Saldo on-chain de un token para una wallet (lectura, sin gas). En DEMO devuelve null.
// Sirve para el backfill: saltar lo que ya está minteado y no malgastar gas en reverts.
async function getOnchainBalance(walletAddress, tokenId) {
  if (DEMO_MODE) return null;
  return withProvider(async (provider) => {
    const abi = ['function balanceOf(address,uint256) view returns (uint256)'];
    const contract = new ethers.Contract(CONTRACT_ADDR, abi, provider);
    const bal = await contract.balanceOf(walletAddress, tokenId);
    return Number(bal);
  });
}

async function getMintStatus(txHash) {
  if (!txHash || txHash.startsWith('demo_')) {
    return { status: 'success' };
  }
  try {
    return await withProvider(async (provider) => {
      const receipt = await provider.getTransactionReceipt(txHash);
      return { status: receipt ? (receipt.status === 1 ? 'success' : 'failed') : 'pending' };
    });
  } catch {
    return { status: 'unknown' };
  }
}

// --- COLA DE TRANSACCIONES EN SEGUNDO PLANO ---
let isProcessing = false;

async function startQueueWorker() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const { getNextPendingMint, updateMintStatus } = require('../db/database');
    
    let nextMint = getNextPendingMint();
    while (nextMint) {
      console.log(`[QueueWorker] Procesando minteo ID ${nextMint.id} para wallet ${nextMint.wallet_address}, nivel ${nextMint.level}`);
      
      try {
        const result = await mintNFT({
          walletAddress: nextMint.wallet_address,
          level: nextMint.level,
          levelName: nextMint.level_name
        });

        updateMintStatus(nextMint.id, 'success', result.walletAddress, result.txHash, result.costMatic || null);
        console.log(`[QueueWorker] ✅ Minteo ID ${nextMint.id} exitoso. Tx: ${result.txHash}`);
      } catch (err) {
        console.error(`[QueueWorker] ❌ Error en minteo ID ${nextMint.id}:`, err.message);
        // Actualizamos a fallido para no bloquear permanentemente la cola
        updateMintStatus(nextMint.id, 'failed', nextMint.wallet_address);
      }

      // Siguiente en la cola
      nextMint = getNextPendingMint();
    }
  } catch (globalErr) {
    console.error('[QueueWorker] Error crítico en bucle de cola:', globalErr);
  } finally {
    isProcessing = false;
  }
}

function notifyQueue() {
  setImmediate(startQueueWorker);
}

// --- COLA DE MINTS DE LOGROS (tokens >= 100, claim del cliente) ---
let isProcessingAch = false;

async function startAchievementQueueWorker() {
  if (isProcessingAch) return;
  isProcessingAch = true;
  try {
    const { getNextPendingAchievementMint, updateAchievementMintStatus } = require('../db/database');
    let next = getNextPendingAchievementMint();
    while (next) {
      console.log(`[AchQueue] Procesando logro ID ${next.id} (token ${next.token_id}) → ${next.wallet_address}`);
      try {
        const result = await mintNFT({ walletAddress: next.wallet_address, tokenId: next.token_id, levelName: next.achievement_id });
        updateAchievementMintStatus(next.id, 'success', result.txHash, result.costMatic || null);
        console.log(`[AchQueue] ✅ Logro ID ${next.id} minteado. Tx: ${result.txHash}`);
      } catch (err) {
        console.error(`[AchQueue] ❌ Error en logro ID ${next.id}:`, err.message);
        updateAchievementMintStatus(next.id, 'failed');
      }
      next = getNextPendingAchievementMint();
    }
  } catch (globalErr) {
    console.error('[AchQueue] Error crítico en bucle de cola:', globalErr);
  } finally {
    isProcessingAch = false;
  }
}

function notifyAchievementQueue() {
  setImmediate(startAchievementQueueWorker);
}

// Iniciar colas al cargar el módulo por si quedaron tareas pendientes de un reinicio previo
setTimeout(startQueueWorker, 1000);
setTimeout(startAchievementQueueWorker, 1200);

module.exports = { mintNFT, getMintStatus, getMinterBalance, getOnchainBalance, DEMO_MODE, notifyQueue, notifyAchievementQueue };

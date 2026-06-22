require('dotenv').config();
const { ethers } = require('ethers');

const POLYGON_RPC   = process.env.POLYGON_RPC_URL || 'https://1rpc.io/matic';
const MINTER_KEY    = process.env.MINTER_PRIVATE_KEY;
const CONTRACT_ADDR = process.env.NFT_CONTRACT_ADDRESS;

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
  console.log('[Polygon] ✅ Modo producción Polygon activo — los mints Nv3/Nv4 van a la blockchain real.');
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

  const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
  const signer   = new ethers.Wallet(MINTER_KEY, provider);
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
  const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
  const wallet = new ethers.Wallet(MINTER_KEY, provider);
  const balanceWei = await provider.getBalance(wallet.address);
  return {
    demo: false,
    address: wallet.address,
    balance: parseFloat(ethers.formatEther(balanceWei))
  };
}

// Saldo on-chain de un token para una wallet (lectura, sin gas). En DEMO devuelve null.
// Sirve para el backfill: saltar lo que ya está minteado y no malgastar gas en reverts.
async function getOnchainBalance(walletAddress, tokenId) {
  if (DEMO_MODE) return null;
  const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
  const abi = ['function balanceOf(address,uint256) view returns (uint256)'];
  const contract = new ethers.Contract(CONTRACT_ADDR, abi, provider);
  const bal = await contract.balanceOf(walletAddress, tokenId);
  return Number(bal);
}

async function getMintStatus(txHash) {
  if (!txHash || txHash.startsWith('demo_')) {
    return { status: 'success' };
  }
  try {
    const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
    const receipt  = await provider.getTransactionReceipt(txHash);
    return { status: receipt ? (receipt.status === 1 ? 'success' : 'failed') : 'pending' };
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

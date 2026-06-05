require('dotenv').config();
const { ethers } = require('ethers');

const POLYGON_RPC   = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const MINTER_KEY    = process.env.MINTER_PRIVATE_KEY;
const CONTRACT_ADDR = process.env.NFT_CONTRACT_ADDRESS;

// Token IDs en el contrato ERC-1155 (0-indexed, tal como los creas en Thirdweb)
const TOKEN_IDS = { 1: 0, 2: 1, 3: 2, 4: 3 };

// ABI mínimo del contrato FuranchoNFT
const ABI = [
  'function mint(address to, uint256 tokenId, uint256 amount) external',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)'
];

const DEMO_MODE = process.env.DEMO_MODE === 'true'
  || !MINTER_KEY
  || !CONTRACT_ADDR
  || MINTER_KEY === 'your_minter_private_key_here';

async function mintNFT({ walletAddress, level, levelName }) {
  if (DEMO_MODE) {
    console.log(`[DEMO] Minting NFT nivel ${level} (${levelName}) → ${walletAddress}`);
    await new Promise(r => setTimeout(r, 1200));
    return {
      success: true,
      txHash: `demo_${Date.now()}`,
      walletAddress,
      demo: true
    };
  }

  const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
  const signer   = new ethers.Wallet(MINTER_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDR, ABI, signer);

  const tokenId = TOKEN_IDS[level];
  if (tokenId === undefined) throw new Error(`Token ID no configurado para nivel ${level}`);

  console.log(`[Polygon] Minting nivel ${level} (tokenId ${tokenId}) → ${walletAddress}`);

  const tx = await contract.mint(walletAddress, tokenId, 1);
  const receipt = await tx.wait();

  console.log(`[Polygon] ✅ TX confirmada: ${receipt.hash}`);
  return {
    success: true,
    txHash: receipt.hash,
    walletAddress,
    demo: false
  };
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

        updateMintStatus(nextMint.id, 'success', result.walletAddress, result.txHash);
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

// Iniciar cola al cargar el módulo por si quedaron tareas pendientes de un reinicio previo
setTimeout(startQueueWorker, 1000);

module.exports = { mintNFT, getMintStatus, DEMO_MODE, notifyQueue };

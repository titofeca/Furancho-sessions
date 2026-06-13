require('dotenv').config();
const { ethers } = require('ethers');

const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://1rpc.io/matic';
const PRIVATE_KEY = process.env.MINTER_PRIVATE_KEY;
const CONTRACT_ADDR = process.env.NFT_CONTRACT_ADDRESS;
const NEW_URI = 'https://furancho-sessions-production.up.railway.app/nft-metadata/{id}';

if (!PRIVATE_KEY || PRIVATE_KEY === 'your_minter_private_key_here') {
  console.error('❌ Error: MINTER_PRIVATE_KEY no está configurada en tu archivo .env local.');
  process.exit(1);
}

if (!CONTRACT_ADDR || CONTRACT_ADDR === 'your_contract_address_here') {
  console.error('❌ Error: NFT_CONTRACT_ADDRESS no está configurada en tu archivo .env local.');
  process.exit(1);
}

async function main() {
  console.log('=== ACTUALIZACIÓN DE URI DE METADATOS ===');
  console.log(`Contrato: ${CONTRACT_ADDR}`);
  console.log(`Nueva URI: ${NEW_URI}`);
  console.log('Conectando a la red Polygon...');

  const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log(`Wallet conectada: ${wallet.address}`);

  // ABI mínimo con la función setURI
  const abi = [
    'function setURI(string memory newURI) external',
    'function owner() external view returns (address)'
  ];

  const contract = new ethers.Contract(CONTRACT_ADDR, abi, wallet);

  try {
    // Verificar si es el owner
    const owner = await contract.owner();
    console.log(`Owner del contrato: ${owner}`);
    
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.warn('⚠️  Atención: La wallet en tu .env no es el Owner del contrato.');
      console.warn('   Si la transacción falla por "Ownable: caller is not the owner", deberás');
      console.warn('   pegar temporalmente la clave privada del creador del contrato en tu .env.');
    }

    console.log('Enviando transacción setURI...');
    const tx = await contract.setURI(NEW_URI);
    console.log(`Transacción enviada. Hash: ${tx.hash}`);
    console.log('Esperando confirmación (esto toma unos segundos)...');
    
    const receipt = await tx.wait();
    console.log('✅ ¡URI actualizada con éxito en la blockchain!');
    console.log(`Bloque: ${receipt.blockNumber}`);
  } catch (error) {
    console.error('❌ Error al actualizar la URI:', error.message);
  }
}

main().catch(console.error);

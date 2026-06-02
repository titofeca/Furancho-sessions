const { ethers } = require('ethers');

const wallet = ethers.Wallet.createRandom();

console.log('\n=== WALLET DEL SERVIDOR (MINTER) ===');
console.log('Dirección pública (para dar permisos en Thirdweb):');
console.log(wallet.address);
console.log('\nClave privada (para Railway → MINTER_PRIVATE_KEY):');
console.log(wallet.privateKey);
console.log('\n⚠️  Guarda la clave privada en un lugar seguro.');
console.log('    Necesitas añadir esta dirección como Minter en el contrato de Thirdweb.');
console.log('    Envía ~2 MATIC a la dirección pública para cubrir gas (miles de mints).\n');

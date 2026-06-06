require('dotenv').config();
const fetch = require('node-fetch');

const CROSSMINT_ENV = process.env.CROSSMINT_ENV || 'staging';
const API_BASE = CROSSMINT_ENV === 'production'
  ? 'https://www.crossmint.com/api/2022-06-09'
  : 'https://staging.crossmint.com/api/2022-06-09';

const API_KEY = process.env.CROSSMINT_API_KEY;
const COLLECTION_ID = process.env.CROSSMINT_COLLECTION_ID;
const DEMO_MODE = process.env.DEMO_MODE === 'true' || !API_KEY || API_KEY === 'your_crossmint_server_api_key_here';

// Template IDs para cada nivel en el contrato ERC-1155
const LEVEL_TEMPLATE_IDS = {
  1: process.env.CROSSMINT_TEMPLATE_N1,
  2: process.env.CROSSMINT_TEMPLATE_N2,
  3: process.env.CROSSMINT_TEMPLATE_N3,
  4: process.env.CROSSMINT_TEMPLATE_N4
};

// URLs de imágenes NFT (para la vista local en modo demo o fallback)
const NFT_IMAGES = {
  1: `${process.env.BASE_URL || 'http://localhost:3000'}/assets/nft_nivel1_cautivo.jpg`,
  2: `${process.env.BASE_URL || 'http://localhost:3000'}/assets/nft_nivel2_cunqueiro.jpg`,
  3: `${process.env.BASE_URL || 'http://localhost:3000'}/assets/nft_nivel3_larpeiro.jpg`,
  4: `${process.env.BASE_URL || 'http://localhost:3000'}/assets/nft_nivel4_presidente.jpg`
};

const LEVEL_DESCRIPTIONS = {
  1: 'Bienvenido al Furancho. Este pase acredita tu primera experiencia en Furancho Sessions, ho.',
  2: 'Ya conoces el sabor de la casa. Este pase certifica tu nivel O Cunqueiro en Furancho Sessions, rapaz.',
  3: 'Eres un auténtico larpeiro, no te pierdes una. Este pase certifica tu nivel O Larpeiro en Furancho Sessions.',
  4: 'La máxima distinción de la parroquia. Este pase certifica que eres el mismísimo Presidente de Furancho Sessions, casi nada.'
};

/**
 * Mintea un NFT a una billetera Polygon. Si DEMO_MODE=true, simula el minteo.
 */
async function mintNFT({ email, walletAddress, level, levelName }) {
  if (DEMO_MODE) {
    // Modo demo: simular minteo exitoso
    console.log(`[DEMO] Minting NFT nivel ${level} (${levelName}) para ${email || walletAddress}`);
    await new Promise(r => setTimeout(r, 1500)); // simular latencia
    return {
      success: true,
      actionId: `demo_${Date.now()}`,
      walletAddress: walletAddress || `0x${Math.random().toString(16).substr(2, 40)}`,
      demo: true
    };
  }

  const templateId = LEVEL_TEMPLATE_IDS[level];
  if (!templateId) {
    throw new Error(`Plantilla del nivel ${level} no configurada en .env`);
  }

  const body = {
    recipient: email ? `email:${email.toLowerCase().trim()}:polygon` : `polygon:${walletAddress}`,
    templateId,
    quantity: 1
  };

  // Endpoint de minteo de SFTs/templates
  const url = `${API_BASE}/collections/${COLLECTION_ID}/nfts`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-API-KEY': API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[Crossmint] Error:', data);
    throw new Error(data.message || 'Error al mintear el NFT');
  }

  return {
    success: true,
    actionId: data.id || data.actionId,
    walletAddress: data.recipient?.walletAddress || walletAddress,
    demo: false
  };
}

/**
 * Consulta el estado de un minteo por actionId
 */
async function getMintStatus(actionId) {
  if (DEMO_MODE || actionId.startsWith('demo_')) {
    return { status: 'success', walletAddress: `0x${Math.random().toString(16).substr(2, 40)}` };
  }

  const response = await fetch(`${API_BASE}/actions/${actionId}`, {
    headers: { 'X-API-KEY': API_KEY }
  });
  const data = await response.json();
  return {
    status: data.status,
    walletAddress: data.data?.recipient?.walletAddress || null
  };
}

module.exports = { mintNFT, getMintStatus, DEMO_MODE, LEVEL_DESCRIPTIONS, NFT_IMAGES };

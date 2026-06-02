const NFT_DATA = {
  1: { name: 'CAUTIVO',      label: 'Nivel 1', image: '/assets/nft_nivel1_cautivo.jpg' },
  2: { name: 'O CUNQUEIRO',  label: 'Nivel 2', image: '/assets/nft_nivel2_cunqueiro.jpg' },
  3: { name: 'O LARPEIRO',   label: 'Nivel 3', image: '/assets/nft_nivel3_larpeiro.jpg' },
  4: { name: 'O PRESIDENTE', label: 'Nivel 4', image: '/assets/nft_nivel4_presidente.jpg' }
};

document.addEventListener('DOMContentLoaded', async () => {
  let privateKey = localStorage.getItem('furancho_private_key');
  let walletAddress = localStorage.getItem('furancho_wallet_address');

  if (!privateKey || !walletAddress) {
    try {
      const res = await fetch('/api/mint/create-wallet', { method: 'POST' });
      const data = await res.json();
      privateKey = data.privateKey;
      walletAddress = data.address;
      localStorage.setItem('furancho_private_key', privateKey);
      localStorage.setItem('furancho_wallet_address', walletAddress);
    } catch (e) {
      alert("Error al generar la cartera. Inténtalo más tarde.");
      return;
    }
  }

  try {
    const res = await fetch('/api/mint/entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress })
    });
    const data = await res.json();

    document.getElementById('screen-loading').style.display = 'none';
    document.getElementById('screen-success').style.display = 'flex';

    if (data.isNew && data.level) {
      const nft = NFT_DATA[data.level];
      document.getElementById('icon-container').innerText = '🎉';
      document.getElementById('title-container').innerText = '¡Bienvenido a Furancho Sessions!';
      document.getElementById('msg-container').innerText = data.message;

      // Mostrar tarjeta NFT con imagen
      const nftContainer = document.getElementById('nft-container');
      nftContainer.innerHTML = `
        <div class="nft-card-top">
          <div class="nft-card-brand">
            <img src="/assets/logo.png" alt="Logo" />
            <span class="nft-card-brand-name">Furancho Sessions</span>
          </div>
          <span class="nft-card-level">${nft.label.toUpperCase()}</span>
        </div>
        <img src="${nft.image}" alt="${nft.name}" style="width:100%;border-radius:12px;margin:12px 0;object-fit:cover;max-height:220px;" />
        <p class="nft-card-title">${nft.name}</p>
        <p class="nft-card-sub">Pase de Bienvenida</p>
      `;
      nftContainer.style.display = 'block';
    }

  } catch (e) {
    alert("Error al registrar entrada.");
  }
});

// ==================== SSE LIVE RAFFLES ====================
function connectRaffle() {
  const evtSource = new EventSource('/api/raffle/stream');

  evtSource.addEventListener('raffle_start', (e) => {
    const data = JSON.parse(e.data);
    const modal = document.getElementById('raffle-modal');
    document.getElementById('raffle-roulette').style.display = 'block';
    document.getElementById('raffle-winner').style.display = 'none';
    document.getElementById('raffle-loser').style.display = 'none';
    document.getElementById('raffle-prize-text').textContent = 'Sorteando: ' + data.prize;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  });

  evtSource.addEventListener('raffle_result', (e) => {
    const data = JSON.parse(e.data);
    const myWallet = localStorage.getItem('furancho_wallet_address');

    document.getElementById('raffle-roulette').style.display = 'none';

    if (data.winnerWallet === myWallet) {
      document.getElementById('raffle-winner').style.display = 'block';
      document.getElementById('raffle-winner-prize').textContent = data.prize;
      document.getElementById('raffle-code').textContent = data.verificationCode;
    } else {
      document.getElementById('raffle-loser').style.display = 'block';
      document.getElementById('raffle-loser-prize').textContent = data.prize;
    }
  });

  evtSource.onerror = () => {};
}

setTimeout(connectRaffle, 2000);

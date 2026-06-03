document.addEventListener('DOMContentLoaded', async () => {
  let walletAddress = localStorage.getItem('furancho_wallet_address');

  if (!walletAddress) {
    try {
      const res = await fetch('/api/mint/create-wallet', { method: 'POST' });
      const data = await res.json();
      walletAddress = data.address;
      localStorage.setItem('furancho_wallet_address', walletAddress);
      localStorage.setItem('furancho_wallet_private_key', data.privateKey);
    } catch (e) {
      showError('Error al conectar. Comprueba tu conexión e inténtalo de nuevo.');
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
    const screen = document.getElementById('screen-success');
    screen.style.display = 'flex';

    if (data.isNew) {
      document.getElementById('icon-container').innerText = '🍷';
      document.getElementById('title-container').innerText = '¡Benvido a Furancho Sessions!';
      document.getElementById('msg-container').innerText = 'É a túa primeira vez aquí. Goza da experiencia e non esquezas fichar á saída para gañar puntos.';
    } else {
      document.getElementById('icon-container').innerText = '🙌';
      document.getElementById('title-container').innerText = '¡Benvido de volta!';
      document.getElementById('msg-container').innerText = 'Que goces moito esta sesión. Non esquezas fichar á saída para acumular a túa visita.';
    }

  } catch (e) {
    showError('Error al registrar entrada. Inténtalo de nuevo.');
  }
});

function showError(msg) {
  document.getElementById('screen-loading').style.display = 'none';
  document.getElementById('screen-success').style.display = 'flex';
  document.getElementById('icon-container').innerText = '⚠️';
  document.getElementById('title-container').innerText = 'Algo fue mal';
  document.getElementById('msg-container').innerText = msg;
}

// ==================== SSE LIVE RAFFLES ====================
function connectRaffle() {
  const wallet = localStorage.getItem('furancho_wallet_address') || '';
  const evtSource = new EventSource(`/api/raffle/stream${wallet ? '?wallet=' + wallet : ''}`);
  evtSource.addEventListener('raffle_start', (e) => {
    const data = JSON.parse(e.data);
    document.getElementById('raffle-prize-text').textContent = 'Sorteando: ' + data.prize;
    document.getElementById('raffle-roulette').style.display = 'block';
    document.getElementById('raffle-winner').style.display = 'none';
    document.getElementById('raffle-loser').style.display = 'none';
    document.getElementById('raffle-modal').style.display = 'flex';
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

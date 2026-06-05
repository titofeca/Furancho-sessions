document.addEventListener('DOMContentLoaded', async () => {
  let walletAddress = localStorage.getItem('furancho_wallet_address');

  if (!walletAddress) {
    // Mostrar pantalla de onboarding — el usuario elige si es nuevo o ya tiene cuenta
    document.getElementById('screen-loading').style.display = 'none';
    document.getElementById('screen-onboarding').style.display = 'flex';
    buildEntryRestoreInputs();
    return;
  }

  await doEntry(walletAddress);
});

async function doEntry(walletAddress) {
  document.getElementById('screen-onboarding').style.display = 'none';
  document.getElementById('screen-loading').style.display = 'flex';

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

    const msgs = [
      'Xa podías tardar máis, ho.',
      'O teu sitio xa te estaba botando de menos.',
      'Que goces como sempre. Que é moito.',
      'Esta noite promete. Como todas no Furancho.',
      'Vaia, xa volveu o mellor cliente.',
    ];
    const randomMsg = msgs[Math.floor(Math.random() * msgs.length)];
    if (data.isNew) {
      document.getElementById('icon-container').innerText = '🍷';
      document.getElementById('title-container').innerText = '¡Benvido ao Furancho!';
      document.getElementById('msg-container').innerText = 'Primeira vez por aquí. Que non sexa a última. Esta noite xa conta como visita.';
    } else {
      document.getElementById('icon-container').innerText = '🙌';
      document.getElementById('title-container').innerText = `¡Ola, de volta pola casa!`;
      document.getElementById('msg-container').innerText = `${randomMsg} Levas ${data.visitCount} visita${data.visitCount !== 1 ? 's' : ''} no Furancho.`;
    }

  } catch (e) {
    showError('Error al registrar entrada. Inténtalo de nuevo.');
  }
}

async function onboardingNew() {
  const btn = document.getElementById('onboarding-new-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creando cuenta...'; }
  try {
    const res = await fetch('/api/mint/create-wallet', { method: 'POST' });
    const data = await res.json();
    if (!data.address) throw new Error('Sin dirección');
    localStorage.setItem('furancho_wallet_address', data.address);
    localStorage.setItem('furancho_wallet_private_key', data.privateKey);
    if (data.mnemonic) localStorage.setItem('furancho_wallet_mnemonic', data.mnemonic);
    if (!localStorage.getItem('furancho_account_created_at')) {
      localStorage.setItem('furancho_account_created_at', new Date().toISOString());
    }
    await doEntry(data.address);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '🍷 Es mi primera vez'; }
    showError('Error al conectar. Comprueba tu conexión e inténtalo de nuevo.');
  }
}

function onboardingShowRecovery() {
  const el = document.getElementById('onboarding-recovery-entry');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function onboardingOpenRestore() {
  const panel = document.getElementById('entry-restore-panel');
  if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function buildEntryRestoreInputs() {
  const container = document.getElementById('entry-restore-inputs');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 1; i <= 12; i++) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;';
    wrapper.innerHTML = `
      <span style="position:absolute; left:8px; top:50%; transform:translateY(-50%); font-size:10px; color:#7A6A5A; font-weight:700; pointer-events:none;">${i}</span>
      <input type="text" inputmode="text" autocomplete="off" autocorrect="off" spellcheck="false"
        placeholder="palabra ${i}"
        style="width:100%; padding:9px 8px 9px 22px; border-radius:10px; border:1.5px solid rgba(42,21,9,0.12); background:rgba(42,21,9,0.03); font-size:13px; font-family:'Outfit',sans-serif; color:#2A1509; box-sizing:border-box; outline:none;"
        oninput="this.value=this.value.toLowerCase().trim()"
        onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();const inputs=document.querySelectorAll('#entry-restore-inputs input');const next=inputs[${i}];if(next)next.focus();}" />
    `;
    container.appendChild(wrapper);
  }
}

async function submitEntryRestore() {
  const inputs = document.querySelectorAll('#entry-restore-inputs input');
  const words = Array.from(inputs).map(i => i.value.trim().toLowerCase()).filter(Boolean);
  const errorEl = document.getElementById('entry-restore-error');
  const btn = document.getElementById('entry-restore-btn');

  if (words.length !== 12) {
    errorEl.textContent = 'Introduce las 12 palabras completas.';
    errorEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verificando...';
  errorEl.style.display = 'none';

  try {
    const res = await fetch('/api/mint/recover-from-phrase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phrase: words.join(' ') })
    });
    const data = await res.json();
    if (data.address) {
      localStorage.setItem('furancho_wallet_address', data.address);
      localStorage.setItem('furancho_wallet_private_key', data.privateKey);
      localStorage.setItem('furancho_wallet_mnemonic', words.join(' '));
      if (!localStorage.getItem('furancho_account_created_at')) {
        localStorage.setItem('furancho_account_created_at', new Date().toISOString());
      }
      await doEntry(data.address);
    } else {
      errorEl.textContent = data.error || 'Frase incorrecta. Revisa las palabras.';
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Recuperar y fichar entrada';
    }
  } catch (e) {
    errorEl.textContent = 'Error de conexión. Inténtalo de nuevo.';
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Recuperar y fichar entrada';
  }
}

function showError(msg) {
  document.getElementById('screen-loading').style.display = 'none';
  document.getElementById('screen-onboarding').style.display = 'none';
  document.getElementById('screen-success').style.display = 'flex';
  document.getElementById('icon-container').innerText = '😬';
  document.getElementById('title-container').innerText = 'Caíuse o viño...';
  document.getElementById('msg-container').innerText = msg;
}

// ==================== SSE LIVE RAFFLES ====================
const _entryWinnerTitles = ['¡CAÍUCHE O PREMIO, HO!','¡TOCOUCHE, CAMPIÓN!','¡A SORTE ESTABA DO TEU LADO!'];
const _entryLoserEmojis = ['😤','🙃','😅','🫠','😬'];
const _entryLoserTitles = ['Esta vez non...','Que mala pata, ho','Nin desta vez'];
const _entryLoserMsgs = [
  'O viño segue na mesa, que non é pouco.',
  'Haberá máis sorteos. A noite é longa.',
  'Non todo o monte é ourego, home.',
  'A bonoloto tampouco, pero aquí estamos.',
];

function connectRaffle() {
  const wallet = localStorage.getItem('furancho_wallet_address') || '';
  const evtSource = new EventSource(`/api/raffle/stream${wallet ? '?wallet=' + wallet : ''}`);
  evtSource.addEventListener('raffle_start', (e) => {
    const data = JSON.parse(e.data);
    document.getElementById('raffle-prize-text').textContent = '⚡ ' + data.prize;
    document.getElementById('raffle-roulette').style.display = 'block';
    document.getElementById('raffle-winner').style.display = 'none';
    document.getElementById('raffle-loser').style.display = 'none';
    document.getElementById('raffle-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    if (navigator.vibrate) navigator.vibrate([100,50,100,50,200]);
  });
  evtSource.addEventListener('raffle_result', (e) => {
    const data = JSON.parse(e.data);
    const myWallet = localStorage.getItem('furancho_wallet_address');
    document.getElementById('raffle-roulette').style.display = 'none';
    if (data.winnerWallet === myWallet) {
      const titleEl = document.getElementById('entry-winner-title');
      if (titleEl) titleEl.textContent = _entryWinnerTitles[Math.floor(Math.random()*_entryWinnerTitles.length)];
      document.getElementById('raffle-winner').style.display = 'block';
      document.getElementById('raffle-winner-prize').textContent = data.prize;
      document.getElementById('raffle-code').textContent = data.verificationCode;
      if (navigator.vibrate) navigator.vibrate([100,50,100,50,100,50,500,100,800]);
    } else {
      const emoji = _entryLoserEmojis[Math.floor(Math.random()*_entryLoserEmojis.length)];
      const title = _entryLoserTitles[Math.floor(Math.random()*_entryLoserTitles.length)];
      const msg = _entryLoserMsgs[Math.floor(Math.random()*_entryLoserMsgs.length)];
      const eEl = document.getElementById('entry-loser-emoji');
      const tEl = document.getElementById('entry-loser-title');
      const mEl = document.getElementById('entry-loser-msg');
      if (eEl) eEl.textContent = emoji;
      if (tEl) tEl.textContent = title;
      document.getElementById('raffle-loser').style.display = 'block';
      document.getElementById('raffle-loser-prize').textContent = data.prize;
      if (mEl) mEl.innerHTML = `O premio de <strong>${data.prize}</strong> foi para outro. ${msg}`;
      if (navigator.vibrate) navigator.vibrate([150]);
    }
  });
  evtSource.onerror = () => {
    evtSource.close();
    setTimeout(connectRaffle, 5000);
  };
}
setTimeout(connectRaffle, 2000);

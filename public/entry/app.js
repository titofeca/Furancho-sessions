// Timer global para poder cancelar la creación automática si el usuario quiere restaurar
window._autoEntryTimeout = null;

async function autoCreateEntryWalletSilently() {
  if (typeof ethers === 'undefined') {
    await new Promise(r => setTimeout(r, 450));
  }
  try {
    let data = generateWalletLocally();
    if (!data) {
      const res = await fetch('/api/mint/create-wallet', { method: 'POST' });
      data = await res.json();
    }
    if (!data.address) throw new Error('Sin dirección');
    localStorage.setItem('furancho_wallet_address', data.address);
    localStorage.setItem('furancho_wallet_private_key', data.privateKey);
    if (data.mnemonic) localStorage.setItem('furancho_wallet_mnemonic', data.mnemonic);
    if (!localStorage.getItem('furancho_account_created_at')) {
      localStorage.setItem('furancho_account_created_at', new Date().toISOString());
    }

    // Actualizar URL con restore param para que añadir a inicio funcione inmediatamente
    const urlParams = new URLSearchParams(window.location.search);
    urlParams.set('restore', data.address);
    history.replaceState(null, '', window.location.pathname + '?' + urlParams.toString());

    await doEntry(data.address);
  } catch (e) {
    console.error('Error en generación automática de wallet en entrada:', e);
    cancelAutoEntryAndShowRecovery();
  }
}

function cancelAutoEntryAndShowRecovery() {
  if (window._autoEntryTimeout) {
    clearTimeout(window._autoEntryTimeout);
    window._autoEntryTimeout = null;
  }
  
  // Ocultar pantalla de carga y mostrar onboarding con opciones de restauración
  document.getElementById('screen-loading').style.display = 'none';
  document.getElementById('screen-onboarding').style.display = 'flex';

  // Detectar si no es modo standalone (corre en navegador común Safari/Chrome)
  const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  if (!isStandalone) {
    const warningEl = document.getElementById('pwa-browser-warning');
    if (warningEl) warningEl.style.display = 'block';
  }

  buildEntryRestoreInputs();
}

document.addEventListener('DOMContentLoaded', async () => {
  let walletAddress = localStorage.getItem('furancho_wallet_address');
  const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;

  // Restauración por URL (?restore=0x...): el QR personal de recuperación también
  // sirve para fichar entrada directamente sin pasar por el onboarding
  if (!walletAddress) {
    const restoreParam = new URLSearchParams(window.location.search).get('restore');
    if (restoreParam && /^0x[a-fA-F0-9]{40}$/.test(restoreParam)) {
      walletAddress = restoreParam;
      localStorage.setItem('furancho_wallet_address', walletAddress);
      if (!localStorage.getItem('furancho_account_created_at')) {
        localStorage.setItem('furancho_account_created_at', new Date().toISOString());
      }
    }
  } else {
    // Si ya tiene wallet, nos aseguramos de que el restore esté siempre en la URL si no es standalone
    if (!isStandalone) {
      const urlParams = new URLSearchParams(window.location.search);
      urlParams.set('restore', walletAddress);
      history.replaceState(null, '', window.location.pathname + '?' + urlParams.toString());
    }
  }

  if (!walletAddress) {
    // Mostrar el botón de restaurar en la pantalla de carga
    const recoveryOption = document.getElementById('loading-recovery-option');
    if (recoveryOption) recoveryOption.style.display = 'block';

    // Dar un margen de 1.5s antes de auto-crear la cuenta para permitir al usuario pulsar "Restaurar"
    window._autoEntryTimeout = setTimeout(autoCreateEntryWalletSilently, 1500);
    return;
  }

  // Si es standalone y tiene el restore en la URL, lo limpiamos para dejarla limpia
  if (isStandalone) {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('restore')) {
      urlParams.delete('restore');
      const search = urlParams.toString();
      history.replaceState(null, '', window.location.pathname + (search ? '?' + search : ''));
    }
  }

  await doEntry(walletAddress);
});

const NEW_WELCOME_MESSAGES = [
  {
    icon: '🍷',
    title: '¡Hola ho! ¡Bienvenido a la esmorga, rapaz!',
    msg: 'Veo que eres nuevo por la parroquia, tronco. Pasa para dentro, búscate un hueco y pídete una cunca de tinto. Eso sí, al loro: no te vayas sin fichar la salida al marchar... ¡que no cobramos por salir, ho, pero al menos queremos saber que saliste entero y no te perdiste por el monte! 😜'
  },
  {
    icon: '🍇',
    title: '¡Home! Una cara nueva en el Furancho, neno.',
    msg: '¿Es tu estreno, rapaz? Apúntate a nuestra cofradía de la buena leria. Pasa y disfruta, pero al loro con el vino de la casa, que entra como el agua y luego te marcas unos bailes ochenteros tú solo... ¡y aquí los premios se dan de uno en uno, carallo! 🍷'
  },
  {
    icon: '🥖',
    title: '¡Bienvenido al templo de la leria, tronco!',
    msg: 'Pasa para adentro, rapaz, que el vino está fresco y el jamón bien cortado, nena. No te olvides de fichar la salida al marchar... ¡a no ser que te quieras quedar a barrer el furancho con nosotros a las tantas! 🧹'
  }
];

const RETURNING_WELCOME_MESSAGES = [
  {
    icon: '🙌',
    title: '¡Hombre, al loro! ¡Otra vez por aquí, carallo!',
    msg: 'Ya me parecía a mí que te gustaba la juerga ochentera. ¡Lleva cuidado, no vayas a heredar el furancho, neno! Pasa y coge sitio, que hoy hay sorteo a ver si tienes potra... ¡o vas a seguir durmiendo en la paja por estar de leria! 😜'
  },
  {
    icon: '🍇',
    title: '¡El hijo pródigo vuelve a la barra, ho!',
    msg: 'Le dije al patrón: "Ese neno vuelve seguro". ¡Y no fallé, tronco! Pasa a mojar la garganta y a ver si hoy haces gasto del de verdad. ¡Recuerda fichar al marchar, rapaz, que las visitas no se acumulan solas!'
  },
  {
    icon: '🍷',
    title: '¡Ya te tardaba venir a la esmorga, ho!',
    msg: 'Ya pensábamos que te habías perdido con el vespino o que te habían metido en el calabozo, rapaz. Pasa y pídete una taza sin miedo, que bien te hace falta. ¡Enséñale al cuerpo lo que es molar de verdad!'
  },
  {
    icon: '🧀',
    title: '¡Ahí llega el peligro del barrio, tronco!',
    msg: '¡Apartad todos, que llega el rey de las cuncas! Pasa para dentro, pero déjanos algo de tinto a los demás, ho. ¡Que luego el patrón dice que nos quedamos sin existencias por tu culpa, carallo!'
  },
  {
    icon: '👑',
    title: '¡Sacad la alfombra roja, neno!',
    msg: '¡Que llega un veterano de las Furancho Sessions! Pasa y pide una taza sin miedo. Cada visita te acerca más a pases de leyenda... ¡y que el tinto no pare, carallo!'
  }
];

async function doEntry(walletAddress) {
  document.getElementById('screen-onboarding').style.display = 'none';
  document.getElementById('screen-loading').style.display = 'flex';

  try {
    const evParam = new URLSearchParams(window.location.search).get('ev') || undefined;
    const res = await fetch('/api/mint/entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, ev: evParam })
    });
    const data = await res.json();

    document.getElementById('screen-loading').style.display = 'none';
    const screen = document.getElementById('screen-success');
    screen.style.display = 'flex';
    const enterBtn = document.querySelector('.btn-enter');
    if (enterBtn) {
      enterBtn.href = `/claim?restore=${walletAddress}`;
    }
    launchConfetti();

    // Pie del mensaje según si la visita contó (evento en agenda + 1ª de la semana)
    let footer;
    if (data.isNew) {
      footer = '<small style="color:var(--gold); font-weight:700;">¡Esta ya cuenta como tu 1ª visita!</small>';
    } else if (data.counted) {
      footer = `<small style="color:var(--wine); font-weight:700;">¡Ya llevas ${data.visitCount} visita${data.visitCount !== 1 ? 's' : ''} registrada${data.visitCount !== 1 ? 's' : ''}!</small>`;
    } else if (data.hasEventNow === false) {
      footer = '<small style="color:var(--wine); font-weight:700;">Hoy no hay sesión en la agenda — la visita no suma, pero la leria nadie te la quita, ho. 🍷</small>';
    } else {
      footer = `<small style="color:var(--wine); font-weight:700;">La visita de esta semana ya estaba contada (llevas ${data.visitCount}) — hoy entra como bis, rapaz. 😜</small>`;
    }

    let selected;
    if (data.isNew || !data.visitCount) {
      // Nuevo de verdad, o primera vez sin evento en agenda (0 visitas): mensaje de estreno
      selected = NEW_WELCOME_MESSAGES[Math.floor(Math.random() * NEW_WELCOME_MESSAGES.length)];
    } else {
      selected = RETURNING_WELCOME_MESSAGES[Math.floor(Math.random() * RETURNING_WELCOME_MESSAGES.length)];
    }
    document.getElementById('icon-container').innerText = selected.icon;
    document.getElementById('title-container').innerText = selected.title;
    document.getElementById('msg-container').innerHTML = `${selected.msg}<br><br>${footer}`;

  } catch (e) {
    showError('Error al registrar entrada. Inténtalo de nuevo.');
  }
}

function launchConfetti() {
  const container = document.getElementById('entry-particles');
  if (!container) return;
  container.innerHTML = '';
  const colors = ['#C4973A','#8B1918','#4ade80','#fff','#F2EDE3','#B52A2A'];
  for (let i = 0; i < 45; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.cssText = `
      left: ${Math.random()*100}%;
      background: ${colors[Math.floor(Math.random()*colors.length)]};
      width: ${5 + Math.random()*8}px;
      height: ${5 + Math.random()*8}px;
      border-radius: ${Math.random() > 0.5 ? '50%' : '3px'};
      animation-delay: ${Math.random()*2}s;
      animation-duration: ${2 + Math.random()*2}s;
    `;
    container.appendChild(p);
  }
}


// Genera la wallet EN el dispositivo con ethers (la clave privada no viaja por la red).
// Devuelve null si ethers no cargó — en ese caso se usa el endpoint del servidor.
function generateWalletLocally() {
  try {
    if (typeof ethers === 'undefined' || !ethers.Wallet?.createRandom) return null;
    const w = ethers.Wallet.createRandom();
    if (!w?.address || !w?.privateKey) return null;
    return { address: w.address, privateKey: w.privateKey, mnemonic: w.mnemonic?.phrase || null };
  } catch (e) { return null; }
}

function recoverWalletLocally(phrase) {
  try {
    if (typeof ethers === 'undefined' || !ethers.Wallet?.fromPhrase) return null;
    const w = ethers.Wallet.fromPhrase(phrase);
    if (!w?.address || !w?.privateKey) return null;
    return { address: w.address, privateKey: w.privateKey };
  } catch (e) {
    if (phrase && phrase.trim().split(/\s+/).length === 12) return { error: 'Frase de recuperación no válida. Comprueba que las palabras son correctas.' };
    return null;
  }
}

async function onboardingNew() {
  const btn = document.getElementById('onboarding-new-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creando cuenta...'; }
  try {
    // 1º intento: generar en el dispositivo; fallback: servidor
    let data = generateWalletLocally();
    if (!data) {
      const res = await fetch('/api/mint/create-wallet', { method: 'POST' });
      data = await res.json();
    }
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
    // 1º intento: recuperar en el dispositivo (la frase no viaja por la red); fallback: servidor
    let data = recoverWalletLocally(words.join(' '));
    if (!data) {
      const res = await fetch('/api/mint/recover-from-phrase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phrase: words.join(' ') })
      });
      data = await res.json();
    }
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

async function handleQrFileUpload(input) {
  if (input.files.length === 0) return;
  const file = input.files[0];
  const btn = document.getElementById('entry-qr-upload-btn');
  const originalText = btn ? btn.innerText : '';

  if (btn) {
    btn.disabled = true;
    btn.innerText = '⌛ Leyendo imagen...';
  }

  let tempReader = document.getElementById('temp-qr-reader');
  if (!tempReader) {
    tempReader = document.createElement('div');
    tempReader.id = 'temp-qr-reader';
    tempReader.style.display = 'none';
    document.body.appendChild(tempReader);
  }

  try {
    const html5QrCode = new Html5Qrcode("temp-qr-reader");
    const decodedText = await html5QrCode.scanFile(file, false);
    const match = decodedText.match(/[\?&]restore=(0x[a-fA-F0-9]{40})/);
    if (match && match[1]) {
      const restoredAddress = match[1];
      localStorage.setItem('furancho_wallet_address', restoredAddress);
      localStorage.setItem('furancho_account_created_at', new Date().toISOString());
      if (btn) btn.innerText = '✅ ¡Recuperado! Fichando...';
      input.value = '';
      await doEntry(restoredAddress);
    } else {
      alert('El QR seleccionado no contiene un enlace de restauración válido.');
      if (btn) { btn.disabled = false; btn.innerText = originalText; }
    }
  } catch (err) {
    console.error(err);
    alert('No se pudo encontrar ningún código QR en la imagen. Asegúrate de subir la captura de pantalla de tu QR de recuperación.');
    if (btn) { btn.disabled = false; btn.innerText = originalText; }
  }
}

function showError(msg) {
  document.getElementById('screen-loading').style.display = 'none';
  document.getElementById('screen-onboarding').style.display = 'none';
  document.getElementById('screen-success').style.display = 'flex';
  document.getElementById('icon-container').innerText = '😬';
  document.getElementById('title-container').innerText = 'Se cayó el vino...';
  document.getElementById('msg-container').innerText = msg;
}

// ==================== SSE LIVE RAFFLES ====================
const _entryWinnerTitles = ['¡TE CAYÓ EL PREMIO, NENO!','¡TE TOCÓ, CAMPEÓN!','¡ESTÁS DE SUERTE, HO!','¡VAYA POTRA, TRONCO!'];
const _entryLoserEmojis = ['😤', '😢', '🥺', '😭', '💔', '🙈'];
const _entryLoserTitles = [
  '❌ No te ha tocado esta vez',
  '❌ El premio fue para otro furancheiro',
  '❌ Otra vez será, rapaz',
  '❌ Esta vez no pudo ser, ho',
];
const _entryLoserMsgs = [
  'Pero el tinto sigue fresco en la mesa, que no es poco.',
  'Habrá más esmorga y más sorteos, ho. La noche es larga.',
  'El mejor premio es estar aquí con la basca, rapaz.',
  'Sigue disfrutando del vinísimo con los tuyos.',
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
    if (myWallet && data.winnerWallet && data.winnerWallet.toLowerCase() === myWallet.toLowerCase()) {
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
      if (mEl) mEl.innerHTML = `El premio de <strong>${data.prize}</strong> fue para otro. ${msg}`;
      if (navigator.vibrate) navigator.vibrate([150]);
    }
  });
  evtSource.addEventListener('raffle_timeout', () => {
    const modal = document.getElementById('raffle-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = 'auto';
  });
  evtSource.addEventListener('raffle_rejected', () => {
    const modal = document.getElementById('raffle-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = 'auto';
  });
  evtSource.addEventListener('raffle_accepted', () => {
    const modal = document.getElementById('raffle-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = 'auto';
  });
  evtSource.onerror = () => {
    evtSource.close();
    setTimeout(connectRaffle, 5000);
  };
}
setTimeout(connectRaffle, 2000);

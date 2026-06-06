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

const NEW_WELCOME_MESSAGES = [
  {
    icon: '🍷',
    title: '¡Hola ho! ¡Bienvenido al Furancho, rapaz!',
    msg: 'Veo que es tu primera vez por aquí. Pasa para dentro, búscate un hueco y pídete una cunca de viño. Eso sí, no te me vayas sin fichar la salida al marchar... ¡que no cobramos por salir, pero al menos queremos saber que quedaste vivo y no te perdiste en el monte! 😜'
  },
  {
    icon: '🍇',
    title: '¡Home! Una cara nueva por la parroquia.',
    msg: '¿Tú eres nuevo por aquí, no? Apúntate a nuestra cofradía de la buena esmorga. Pasa y disfruta, pero cuidado con el vino de la casa, que entra como el agua y luego ves doble... ¡y aquí los premios se dan de uno en uno, carallo! 🍷'
  },
  {
    icon: '🥖',
    title: '¡Bienvenido al templo de la leria, rapaz!',
    msg: 'Pasa para adentro, que el vino está frío, la leria caliente y el jamón bien cortado. No te olvides de fichar la salida al marchar... ¡a no ser que te quieras quedar a barrer el furancho con nosotros a las tantas! 🧹'
  }
];

const RETURNING_WELCOME_MESSAGES = [
  {
    icon: '🙌',
    title: '¡Otra vez tú por aquí, carallo!',
    msg: 'Ya me parecía a mí que te gustaba mucho la esmorga. ¡Lleva cuidado no vayas a heredar el furancho! Pasa y coge sitio, que hoy hay sorteo a ver si tienes más suerte que el otro día... ¡o vas a seguir durmiendo en la paja por estar de leria! 😜'
  },
  {
    icon: '🍇',
    title: '¡El hijo pródigo vuelve a la casa!',
    msg: 'Le dije al patrón: "Ese vuelve seguro, ho". ¡Y no fallé! Pasa a mojar la garganta y a ver si hoy haces gasto del de verdad. ¡Recuerda fichar al marchar, rapaz, que las visitas no se acumulan solas!'
  },
  {
    icon: '🍷',
    title: '¡Ya te tardaba venir, ho!',
    msg: 'Ya pensábamos que te habías perdido por el monte con las cabras o que te habían metido en el calabozo. Pasa y pídete una cunca de tinto, que bien te hace falta. ¡Enséñale al cuerpo que sigues con ganas de esmorga!'
  },
  {
    icon: '🧀',
    title: '¡Ahí viene el peligro de la parroquia!',
    msg: '¡Apartad todos, que llega el profesional de las cuncas! Pasa para dentro, pero déjanos algo de viño a los demás, ho. ¡Que luego dicen que nos quedamos sin existencias por tu culpa!'
  },
  {
    icon: '👑',
    title: '¡Sacad la alfombra roja, rapaz!',
    msg: '¡Que llega un veterano del Furancho! Pasa para dentro y pide una taza sin miedo. Cada visita te acerca más a pases de leyenda... ¡y que el viño no pare, carallo!'
  }
];

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
    launchConfetti();

    let selected;
    if (data.isNew) {
      selected = NEW_WELCOME_MESSAGES[Math.floor(Math.random() * NEW_WELCOME_MESSAGES.length)];
      document.getElementById('icon-container').innerText = selected.icon;
      document.getElementById('title-container').innerText = selected.title;
      document.getElementById('msg-container').innerHTML = `${selected.msg}<br><br><small style="color:var(--gold); font-weight:700;">¡Esta ya cuenta como tu 1ª visita!</small>`;
    } else {
      selected = RETURNING_WELCOME_MESSAGES[Math.floor(Math.random() * RETURNING_WELCOME_MESSAGES.length)];
      document.getElementById('icon-container').innerText = selected.icon;
      document.getElementById('title-container').innerText = selected.title;
      document.getElementById('msg-container').innerHTML = `${selected.msg}<br><br><small style="color:var(--wine); font-weight:700;">¡Ya llevas ${data.visitCount} visita${data.visitCount !== 1 ? 's' : ''} registrada${data.visitCount !== 1 ? 's' : ''}!</small>`;
    }

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
  document.getElementById('title-container').innerText = 'Se cayó el vino...';
  document.getElementById('msg-container').innerText = msg;
}

// ==================== SSE LIVE RAFFLES ====================
const _entryWinnerTitles = ['¡TE CAYÓ EL PREMIO, HO!','¡TE TOCÓ, CAMPEÓN!','¡LA SUERTE ESTABA DE TU LADO!'];
const _entryLoserEmojis = ['😤','🙃','😅','🫠','😬'];
const _entryLoserTitles = ['Esta vez no...','Qué mala pata, ho','Ni esta vez'];
const _entryLoserMsgs = [
  'El vino sigue en la mesa, que no es poco.',
  'Habrá más sorteos. La noche es larga.',
  'No todo el monte es orégano, hombre.',
  'La bonoloto tampoco, pero aquí estamos.',
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
      if (mEl) mEl.innerHTML = `El premio de <strong>${data.prize}</strong> fue para otro. ${msg}`;
      if (navigator.vibrate) navigator.vibrate([150]);
    }
  });
  evtSource.onerror = () => {
    evtSource.close();
    setTimeout(connectRaffle, 5000);
  };
}
setTimeout(connectRaffle, 2000);

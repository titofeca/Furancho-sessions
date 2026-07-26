const fs = require('fs');
let content = fs.readFileSync('public/staff/index.html', 'utf8');

const audioScript = `
  // ==================== GLOBAL ALERTS (SOUND, VIBRATION, NOTIFICATIONS) ====================
  let _audioCtx = null;
  function initAudio() {
    if (!_audioCtx) {
      try {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {}
    }
    if (_audioCtx && _audioCtx.state === 'suspended') {
      _audioCtx.resume();
    }
  }

  function playDingSound() {
    if (!_audioCtx) return;
    try {
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
      const osc = _audioCtx.createOscillator();
      const gain = _audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, _audioCtx.currentTime); // A5
      osc.frequency.exponentialRampToValueAtTime(1760, _audioCtx.currentTime + 0.1); 
      gain.gain.setValueAtTime(1, _audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, _audioCtx.currentTime + 1.5);
      osc.connect(gain);
      gain.connect(_audioCtx.destination);
      osc.start();
      osc.stop(_audioCtx.currentTime + 1.5);
    } catch(e){}
  }

  function playGlobalAlert(title, msg) {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
    playDingSound();
    
    if (typeof showToast === 'function') {
      showToast((title ? title + ' - ' : '') + msg);
    } else {
      alert((title ? title + ' - ' : '') + msg);
    }
    
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(title || 'Furancho Staff', { body: msg }); } catch(e){}
    }
  }
`;

if (!content.includes('function playGlobalAlert')) {
  // Find a good place to inject the script. Just before the first function declaration is good.
  content = content.replace('// ==================== FUNCIONES PRINCIPALES ====================', audioScript + '\n  // ==================== FUNCIONES PRINCIPALES ====================');
  
  // Try to find the login function (e.g. login or handleLogin or doLogin)
  if (content.includes('function doLogin')) {
    content = content.replace('function doLogin', 'function doLogin(e) { if(e) e.preventDefault(); initAudio();');
  } else if (content.includes('function handleLogin')) {
    content = content.replace('function handleLogin', 'function handleLogin(e) { if(e) e.preventDefault(); initAudio();');
  } else {
    // If not found, attach it to the login button click
    content = content.replace(/id="btn-login"/, 'id="btn-login" onclick="initAudio()"');
  }

  // Hook into SSE events
  content = content.replace(
    /if\s*\(_staffSse\)\s*\{[\s\S]*?_staffSse\.addEventListener\('corcho_pending',\s*\([^)]*\)\s*=>\s*\{/g,
    '$&\n      playGlobalAlert("🪙 Banco do Corcho", "Nueva recarga pendiente de revisión");'
  );

  fs.writeFileSync('public/staff/index.html', content);
  console.log('staff patched');
} else {
  console.log('staff already patched');
}

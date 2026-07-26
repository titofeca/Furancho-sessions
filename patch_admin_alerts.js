const fs = require('fs');
let content = fs.readFileSync('public/admin/index.html', 'utf8');

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
      osc.frequency.exponentialRampToValueAtTime(1760, _audioCtx.currentTime + 0.1); // Up to A6 for a "ding"
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
    
    // In-App banner if showToast exists, else alert
    if (typeof showToast === 'function') {
      showToast((title ? title + ' - ' : '') + msg);
    } else {
      alert((title ? title + ' - ' : '') + msg);
    }
    
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(title || 'Furancho Alert', { body: msg }); } catch(e){}
    }
  }
`;

if (!content.includes('function playGlobalAlert')) {
  content = content.replace('// ==================== GLOBAL VARIABLES ====================', audioScript + '\n  // ==================== GLOBAL VARIABLES ====================');
  
  // Inject initAudio in handleLogin
  content = content.replace(
    'function handleLogin(event) {',
    'function handleLogin(event) {\n    initAudio();'
  );
  
  // Modify SSE listeners
  content = content.replace(
    'showVipRequestNotification(data);',
    'playGlobalAlert("🎟️ Reserva VIP", "Nueva solicitud de " + (data.alias || data.walletMasked));\n        showVipRequestNotification(data);'
  );
  
  content = content.replace(
    /adminSseSource\.addEventListener\('corcho_pending',\s*\([^)]*\)\s*=>\s*\{/,
    '$&\n      playGlobalAlert("🪙 Banco do Corcho", "Nueva recarga pendiente de revisión");'
  );
  
  content = content.replace(
    /adminSseSource\.addEventListener\('weekly_chat_message',\s*\([^)]*\)\s*=>\s*\{/,
    '$&\n      try { const d = JSON.parse(e.data); if (d.sender==="client") playGlobalAlert("💬 Mensaje Semanal", "Nuevo mensaje de un cliente"); } catch(e){}'
  );
  
  fs.writeFileSync('public/admin/index.html', content);
}

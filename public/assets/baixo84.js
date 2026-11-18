/* ==========================================================================
   FURANCHO SESSIONS · MOTOR 3D "O BAIXO DA CASA 1984" + ROUTER DE MENÚS (v3)
   Garantiza flujo instantáneo y sin bloqueos entre todos los menús y juegos:
   cierre determinista sin race-conditions de 280ms, dock persistente para
   cambiar de sección con 1 toque y cabeceras de retorno visibles en cada modal.
   ========================================================================== */
(function () {
  'use strict';

  // ── 1. MOTOR DE SONIDO PROCEDURAL TABERNA AÑOS 80 (WebAudio · 0 KB) ──────
  var audioCtx = null;
  var soundMuted = localStorage.getItem('furancho_sound_muted') === '1';

  function getAudio() {
    if (soundMuted) return null;
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (_) {
      return null;
    }
  }

  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) {}
  }

  var FuranchoAudio = {
    isMuted: function () { return soundMuted; },
    toggleMute: function () {
      soundMuted = !soundMuted;
      localStorage.setItem('furancho_sound_muted', soundMuted ? '1' : '0');
      if (!soundMuted) FuranchoAudio.woodTap();
      return soundMuted;
    },
    woodTap: function () {
      var ctx = getAudio();
      if (!ctx) return;
      var t = ctx.currentTime;
      var osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(190, t);
      osc.frequency.exponentialRampToValueAtTime(68, t + 0.055);
      g.gain.setValueAtTime(0.15, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.065);
    },
    clinkCunca: function () {
      var ctx = getAudio();
      if (!ctx) return;
      var t = ctx.currentTime;
      [980, 1480].forEach(function (freq, idx) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(freq, t + idx * 0.02);
        g.gain.setValueAtTime(0.11, t + idx * 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.24 + idx * 0.04);
        o.connect(g); g.connect(ctx.destination);
        o.start(t + idx * 0.02); o.stop(t + idx * 0.02 + 0.28);
      });
    },
    ironClank: function (hitType) {
      var ctx = getAudio();
      if (hitType === 'pleno') vibrate([40, 30, 90]);
      else if (hitType === 'roce') vibrate(35);
      else vibrate(15);
      if (!ctx) return;
      var t = ctx.currentTime;
      if (hitType === 'miss') {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(110, t);
        o.frequency.exponentialRampToValueAtTime(38, t + 0.14);
        g.gain.setValueAtTime(0.22, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        o.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + 0.16);
        return;
      }
      var freqs = hitType === 'pleno' ? [620, 1245, 1890, 2640] : [540, 1090];
      var dur = hitType === 'pleno' ? 0.65 : 0.28;
      freqs.forEach(function (f, i) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = i % 2 === 0 ? 'triangle' : 'sine';
        o.frequency.setValueAtTime(f, t);
        g.gain.setValueAtTime(0.14 / (i + 1), t);
        g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
        o.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + dur + 0.02);
      });
    },
    reelTick: function (pitch) {
      var ctx = getAudio();
      if (!ctx) return;
      var t = ctx.currentTime;
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(pitch || 320, t);
      g.gain.setValueAtTime(0.045, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + 0.03);
    },
    coinDrop: function () {
      var ctx = getAudio();
      vibrate([25, 35, 25, 35, 50]);
      if (!ctx) return;
      var t = ctx.currentTime;
      [1318, 1567, 2093, 2637].forEach(function (f, i) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(f, t + i * 0.075);
        g.gain.setValueAtTime(0.11, t + i * 0.075);
        g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.075 + 0.22);
        o.connect(g); g.connect(ctx.destination);
        o.start(t + i * 0.075); o.stop(t + i * 0.075 + 0.24);
      });
    },
    fireWhoosh: function () {
      var ctx = getAudio();
      vibrate(20);
      if (!ctx) return;
      var t = ctx.currentTime;
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(420, t + 0.12);
      o.frequency.exponentialRampToValueAtTime(95, t + 0.26);
      g.gain.setValueAtTime(0.08, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + 0.3);
    }
  };
  window.FuranchoAudio = FuranchoAudio;

  // ── 2. ROUTER UNIFICADO DE MENÚS Y MODALES (CERO ESTADOS COLGADOS) ────────
  var ALL_MANAGED_MODALS = [
    'id-modal',
    'prizes-history-modal',
    'ruta-modal',
    'chave-modal',
    'levels-modal',
    'msg-panel',
    'b84-libreta-modal',
    'minigames-menu-modal',
    'enxebre-modal',
    'enxebre-help-modal',
    'cunca-modal',
    'cunca-help-modal',
    'ruleta-modal',
    'ruleta-help-modal',
    'queimada-modal',
    'queimada-help-modal',
    'rasca-modal',
    'traga-modal',
    'chave-virtual-modal',
    'trivial-modal',
    'corcho-items-modal',
    'corcho-packs-modal',
    'corcho-transfer-modal',
    'corcho-info-modal',
    'corcho-voucher-modal',
    'transfer-modal',
    'allergens-modal'
  ];

  // Timers activos de juegos para cancelarlos al salir del juego o cambiar de menú
  var _gameTimers = {
    tragaSpin: null,
    tragaReopen: null,
    chaveReopen: null,
    trivialTick: null
  };

  function clearAllGameTimers() {
    if (_gameTimers.tragaSpin) { clearInterval(_gameTimers.tragaSpin); _gameTimers.tragaSpin = null; }
    if (_gameTimers.tragaReopen) { clearTimeout(_gameTimers.tragaReopen); _gameTimers.tragaReopen = null; }
    if (_gameTimers.chaveReopen) { clearTimeout(_gameTimers.chaveReopen); _gameTimers.chaveReopen = null; }
    if (_gameTimers.trivialTick) { clearInterval(_gameTimers.trivialTick); _gameTimers.trivialTick = null; }
  }

  function isModalVisible(id) {
    var el = document.getElementById(id);
    return !!(el && el.style.display && el.style.display !== 'none');
  }

  var B84Nav = {
    closeAll: function (exceptId) {
      clearAllGameTimers();
      if (typeof window.stopCampaignQr === 'function' && exceptId !== 'id-modal') {
        try { window.stopCampaignQr(); } catch (_) {}
      }
      if (exceptId !== 'enxebre-modal' && typeof window.handleEnxebreKeydown === 'function') {
        try { document.removeEventListener('keydown', window.handleEnxebreKeydown); } catch (_) {}
      }
      if (exceptId !== 'client-scanner-modal' && isModalVisible('client-scanner-modal')) {
        if (typeof window.stopClientScanner === 'function') {
          try { window.stopClientScanner(); } catch (_) {
            document.getElementById('client-scanner-modal').style.display = 'none';
          }
        }
      }
      ALL_MANAGED_MODALS.forEach(function (id) {
        if (id === exceptId) return;
        var m = document.getElementById(id);
        if (m && m.style.display !== 'none') {
          m.style.display = 'none';
        }
      });
      if (!exceptId) {
        document.body.style.overflow = '';
      }
      B84Nav.syncDockActive();
    },

    getActiveSection: function () {
      if (isModalVisible('client-scanner-modal')) return 'fichar';
      if (isModalVisible('id-modal')) return 'carne';
      if (isModalVisible('b84-libreta-modal') || isModalVisible('corcho-items-modal') || isModalVisible('corcho-packs-modal') || isModalVisible('corcho-transfer-modal') || isModalVisible('corcho-info-modal') || isModalVisible('corcho-voucher-modal')) return 'banco';
      if (isModalVisible('minigames-menu-modal') || isModalVisible('enxebre-modal') || isModalVisible('ruleta-modal') || isModalVisible('queimada-modal') || isModalVisible('rasca-modal') || isModalVisible('traga-modal') || isModalVisible('chave-virtual-modal') || isModalVisible('trivial-modal') || isModalVisible('cunca-modal')) return 'xogos';
      if (isModalVisible('chave-modal')) return 'chave';
      if (isModalVisible('prizes-history-modal') || isModalVisible('transfer-modal')) return 'museo';
      if (isModalVisible('ruta-modal')) return 'ruta';
      return null;
    },

    syncDockActive: function () {
      var activeSec = B84Nav.getActiveSection();
      ['fichar', 'carne', 'banco', 'xogos', 'chave', 'museo', 'ruta'].forEach(function (sec) {
        var btn = document.getElementById('b84-dock-btn-' + sec);
        if (btn) btn.classList.toggle('active', activeSec === sec);
      });
    },

    dockTap: function (sec) {
      FuranchoAudio.woodTap();
      var current = B84Nav.getActiveSection();
      // Si tocas la misma pestaña que ya está abierta, se cierra y vuelves limpio al Baixo
      if (current === sec && sec !== 'fichar') {
        B84Nav.closeAll();
        return;
      }
      if (sec === 'fichar') {
        B84Nav.closeAll();
        smartFicharAction();
      } else if (sec === 'carne') {
        window.openIdModal();
      } else if (sec === 'banco') {
        window.openLibreta84Modal();
      } else if (sec === 'xogos') {
        window.openMinigamesModal();
      } else if (sec === 'chave') {
        window.openChaveModal();
      } else if (sec === 'museo') {
        window.openPrizesModal();
      } else if (sec === 'ruta') {
        window.openRutaModal();
      }
      B84Nav.syncDockActive();
    },

    backToGamesMenu: function () {
      FuranchoAudio.woodTap();
      B84Nav.closeAll('minigames-menu-modal');
      window.openMinigamesModal();
    }
  };
  window.B84Nav = B84Nav;

  // Cerrar con tecla Escape en escritorio
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && B84Nav.getActiveSection()) {
      B84Nav.closeAll();
    }
  });

  // Inyectar cabeceras con botón "← Volver ao Baixo" y "✕" en modales largos sin botón superior
  function injectSheetTopbars() {
    [
      { id: 'id-modal', title: '🪪 Carné Furancheiro' },
      { id: 'prizes-history-modal', title: '🏺 Museo do Furancho' },
      { id: 'ruta-modal', title: '🗺️ Ruta Furancheira' }
    ].forEach(function (cfg) {
      var modal = document.getElementById(cfg.id);
      if (!modal) return;
      var sheet = modal.firstElementChild;
      if (!sheet || sheet.querySelector('.b84-sheet-topbar')) return;

      // Ocultar el antiguo tirador gris decorativo sin acción
      var oldHandle = sheet.firstElementChild;
      if (oldHandle && oldHandle.offsetHeight < 36 && !oldHandle.classList.contains('cin-poster')) {
        oldHandle.style.display = 'none';
      }

      var bar = document.createElement('div');
      bar.className = 'b84-sheet-topbar';
      bar.innerHTML =
        '<button type="button" class="b84-sheet-back" onclick="B84Nav.closeAll()">← Volver ao Baixo</button>' +
        '<button type="button" class="b84-sheet-close" onclick="B84Nav.closeAll()" aria-label="Pechar">✕</button>';
      sheet.insertBefore(bar, sheet.firstChild);

      modal.addEventListener('click', function (e) {
        if (e.target === modal) B84Nav.closeAll();
      });
    });

    // Añadir botón "← Libreta" y cierre al pulsar fuera en los 4 submenús del Banco
    ['corcho-items-modal', 'corcho-packs-modal', 'corcho-transfer-modal', 'corcho-info-modal'].forEach(function (cid) {
      var cm = document.getElementById(cid);
      if (!cm) return;
      cm.addEventListener('click', function (e) {
        if (e.target === cm) B84Nav.closeAll();
      });
      var card = cm.firstElementChild;
      if (!card || card.querySelector('.b84-back-to-libreta')) return;
      var backLib = document.createElement('button');
      backLib.type = 'button';
      backLib.className = 'b84-back-to-libreta';
      backLib.textContent = '← Volver á Libreta';
      backLib.onclick = function (e) {
        e.stopPropagation();
        FuranchoAudio.woodTap();
        window.openLibreta84Modal();
      };
      card.insertBefore(backLib, card.firstChild);
    });

    var lvlModal = document.getElementById('levels-modal');
    if (lvlModal) {
      lvlModal.addEventListener('click', function (e) {
        if (e.target === lvlModal) B84Nav.closeAll();
      });
    }

    // Añadir botón "← Xogos" y cierre determinista a todos los juegos individuales
    ['enxebre-modal', 'ruleta-modal', 'queimada-modal', 'rasca-modal', 'traga-modal', 'chave-virtual-modal', 'trivial-modal'].forEach(function (gid) {
      var gm = document.getElementById(gid);
      if (!gm || gm.querySelector('.b84-back-to-games')) return;
      var backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'b84-back-to-games';
      backBtn.textContent = '← Xogos';
      backBtn.onclick = function (e) {
        e.stopPropagation();
        B84Nav.backToGamesMenu();
      };
      gm.appendChild(backBtn);

      // Interceptar botones inline de cierre directo (style.display='none') para limpiar timers y dock al instante
      gm.querySelectorAll('button[onclick*="style.display"]').forEach(function (closeBtn) {
        if (closeBtn.getAttribute('onclick').indexOf('help-modal') !== -1) return;
        closeBtn.onclick = function (ev) {
          ev.stopPropagation();
          B84Nav.closeAll();
        };
      });

      // Clic en el fondo oscuro cierra limpio y cancela timers
      gm.addEventListener('click', function (e) {
        if (e.target === gm) B84Nav.closeAll();
      });
    });
  }

  // Envolver TODAS las funciones globales de abrir/cerrar modales para erradicar los
  // setTimeout(280ms) con condición de carrera y el bloqueo de overflow:hidden
  function patchGlobalModalFunctions() {
    var origOpenId = window.openIdModal;
    window.openIdModal = function () {
      B84Nav.closeAll('id-modal');
      if (typeof origOpenId === 'function') origOpenId();
      var m = document.getElementById('id-modal');
      if (m) m.style.display = 'flex';
      B84Nav.syncDockActive();
    };
    window.closeIdModal = function () { B84Nav.closeAll(); };

    var origOpenPrizes = window.openPrizesModal;
    window.openPrizesModal = function () {
      B84Nav.closeAll('prizes-history-modal');
      if (typeof origOpenPrizes === 'function') origOpenPrizes();
      var m = document.getElementById('prizes-history-modal');
      if (m) m.style.display = 'flex';
      B84Nav.syncDockActive();
    };
    window.closePrizesModal = function () { B84Nav.closeAll(); };

    var origOpenRuta = window.openRutaModal;
    window.openRutaModal = function () {
      B84Nav.closeAll('ruta-modal');
      if (typeof origOpenRuta === 'function') origOpenRuta();
      var m = document.getElementById('ruta-modal');
      if (m) m.style.display = 'flex';
      B84Nav.syncDockActive();
    };
    window.closeRutaModal = function () { B84Nav.closeAll(); };

    var origOpenChave = window.openChaveModal;
    window.openChaveModal = function () {
      B84Nav.closeAll('chave-modal');
      if (typeof origOpenChave === 'function') origOpenChave();
      var m = document.getElementById('chave-modal');
      if (m) m.style.display = 'flex';
      // Si aún no abrió la ventana del domingo o está en vacaciones, mostrar aviso claro dentro del modal
      var prizeEl = document.getElementById('chave-modal-prize');
      if (prizeEl && (!prizeEl.textContent || prizeEl.textContent === '—' || prizeEl.textContent.includes('secreto'))) {
        if (window.isVacationMode) {
          prizeEl.textContent = '🏖️ A Chave Semanal descansa en Modo Vacacións — volverá coa nova tempada, ho.';
        }
      }
      document.body.style.overflow = '';
      B84Nav.syncDockActive();
    };
    window.closeChaveModal = function () { B84Nav.closeAll(); };

    // Hacer que pulsar Chave SIEMPRE abra el modal informativo en vez de no hacer nada cuando _lastWeeklyData es null
    window.onChaveMedallionClick = function () {
      window.openChaveModal();
    };

    window.openLevelsModal = function () {
      B84Nav.closeAll('levels-modal');
      var m = document.getElementById('levels-modal');
      if (m) m.style.display = 'flex';
      B84Nav.syncDockActive();
    };
    window.closeLevelsModal = function () { B84Nav.closeAll(); };

    var origOpenItems = window.openCorchoItemsModal;
    window.openCorchoItemsModal = async function () {
      B84Nav.closeAll('corcho-items-modal');
      if (typeof origOpenItems === 'function') await origOpenItems();
      B84Nav.syncDockActive();
    };
    var origCloseItems = window.closeCorchoItemsModal;
    window.closeCorchoItemsModal = function () {
      if (typeof origCloseItems === 'function') origCloseItems();
      B84Nav.syncDockActive();
    };

    var origOpenPacks = window.openCorchoPacksModal;
    window.openCorchoPacksModal = async function () {
      B84Nav.closeAll('corcho-packs-modal');
      if (typeof origOpenPacks === 'function') await origOpenPacks();
      B84Nav.syncDockActive();
    };
    var origClosePacks = window.closeCorchoPacksModal;
    window.closeCorchoPacksModal = function () {
      if (typeof origClosePacks === 'function') origClosePacks();
      B84Nav.syncDockActive();
    };

    var origOpenTransfer = window.openCorchoTransferModal;
    window.openCorchoTransferModal = function () {
      B84Nav.closeAll('corcho-transfer-modal');
      if (typeof origOpenTransfer === 'function') origOpenTransfer();
      B84Nav.syncDockActive();
    };
    var origCloseTransfer = window.closeCorchoTransferModal;
    window.closeCorchoTransferModal = function () {
      if (typeof origCloseTransfer === 'function') origCloseTransfer();
      B84Nav.syncDockActive();
    };

    var origOpenInfo = window.openCorchoInfoModal;
    window.openCorchoInfoModal = function () {
      B84Nav.closeAll('corcho-info-modal');
      if (typeof origOpenInfo === 'function') origOpenInfo();
      B84Nav.syncDockActive();
    };
    var origCloseInfo = window.closeCorchoInfoModal;
    window.closeCorchoInfoModal = function () {
      if (typeof origCloseInfo === 'function') origCloseInfo();
      B84Nav.syncDockActive();
    };

    var origStartTransferScan = window.startTransferScan;
    if (typeof origStartTransferScan === 'function') {
      window.startTransferScan = function () {
        B84Nav.closeAll('transfer-modal');
        return origStartTransferScan();
      };
    }

    var origOpenMsg = window.openMsgPanel;
    if (typeof origOpenMsg === 'function') {
      window.openMsgPanel = function () {
        B84Nav.closeAll('msg-panel');
        origOpenMsg();
      };
    }

    // Unificar funciones de cierre de juegos para limpiar timers y dock al instante
    ['closeEnxebre', 'closeRuletaModal', 'closeQueimadaModal', 'closeRascaModal', 'closeCuncaQuente'].forEach(function (fnName) {
      var origFn = window[fnName];
      window[fnName] = function () {
        if (typeof origFn === 'function') {
          try { origFn(); } catch (_) {}
        }
        B84Nav.closeAll();
      };
    });
  }

  // ── 3. ESCENARIO 3D "O BAIXO DA CASA 1984" ────────────────────────────────
  function isUserInside() {
    var badge = document.getElementById('session-active-badge');
    return !!(badge && badge.style.display !== 'none');
  }

  function smartFicharAction() {
    FuranchoAudio.clinkCunca();
    if (isUserInside()) {
      if (typeof window.marcharDoFurancho === 'function') window.marcharDoFurancho();
    } else {
      if (typeof window.startClientScanner === 'function') window.startClientScanner();
    }
  }
  window.smartFicharAction = smartFicharAction;

  var STATIONS = [
    {
      id: 'porta',
      tab: '🚪 Porta',
      icon: '🌿',
      pinLabel: 'Porta do Loureiro',
      title: 'Porta do Loureiro · Fichaxe',
      sub: '📷 Escanea o QR da porta ao chegar',
      cta: 'Fichar ›',
      pan: -0.90,
      left: '18%',
      top: '48%',
      open: function () { B84Nav.dockTap('fichar'); }
    },
    {
      id: 'pizarra',
      tab: '🔑 Rifas',
      icon: '🔑',
      pinLabel: 'Pizarra e Sorteos',
      title: 'Pizarra de Tiza · A Chave e Rifas',
      sub: 'Consulta o sorteo semanal e premios',
      cta: 'Ver Sorteo ›',
      pan: -0.36,
      left: '40.5%',
      top: '33%',
      open: function () {
        var acceptBanner = document.getElementById('accept-prize-banner');
        if (acceptBanner && acceptBanner.style.display !== 'none') {
          B84Nav.closeAll();
          acceptBanner.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          window.openChaveModal();
        }
      }
    },
    {
      id: 'banco',
      tab: '📒 Banco',
      icon: '📒',
      pinLabel: 'Libreta do Corcho',
      title: 'Libreta do Corcho · 1984',
      sub: '0 $CORCHO · Canxes, Packs e Movementos',
      cta: 'Abrir Libreta ›',
      pan: -0.02,
      left: '49%',
      top: '78%',
      open: function () { window.openLibreta84Modal(); }
    },
    {
      id: 'cunca',
      tab: '🍷 Cunca',
      icon: '🍷',
      pinLabel: 'A Cunca · Niveis',
      title: 'Jarra e Cunca · O teu Nivel VIP',
      sub: '0 visitas · Cautivo → Presidente',
      cta: 'Ver Niveis ›',
      pan: 0.16,
      left: '61%',
      top: '66%',
      open: function () {
        FuranchoAudio.clinkCunca();
        window.openLevelsModal();
      }
    },
    {
      id: 'xogos',
      tab: '🕹️ Xogos',
      icon: '🕹️',
      pinLabel: 'Recreativos \'85',
      title: 'Recreativos \'85 e Pote de Queimada',
      sub: '8 Xogos enxebres para gañar $CORCHO',
      cta: 'Xogar ›',
      pan: 0.48,
      left: '69.5%',
      top: '42%',
      open: function () { window.openMinigamesModal(); }
    },
    {
      id: 'museo',
      tab: '🏺 Museo',
      icon: '🏺',
      pinLabel: 'Alacena · Museo',
      title: 'A Alacena · Museo do Furancho',
      sub: 'Os teus NFTs, premios e reliquias',
      cta: 'Ver Museo ›',
      pan: 0.90,
      left: '83.5%',
      top: '36%',
      open: function () { window.openPrizesModal(); }
    }
  ];

  var focusedIdx = 2;
  var panNorm = STATIONS[2].pan;
  var targetPanNorm = STATIONS[2].pan;
  var tiltY = 0, targetTiltY = 0;
  var vivaMode = false;
  var fxCanvas = null, fxCtx = null, panWorld = null;
  var stageRunning = false;
  var rainDrops = [], dustMotes = [];

  for (var r = 0; r < 22; r++) {
    rainDrops.push({ x: 0.04 + Math.random() * 0.16, y: 0.16 + Math.random() * 0.68, sp: 0.012 + Math.random() * 0.009 });
  }
  for (var m = 0; m < 26; m++) {
    dustMotes.push({ x: 0.22 + Math.random() * 0.72, y: 0.12 + Math.random() * 0.78, r: 0.7 + Math.random() * 1.4, vx: (Math.random() - 0.5) * 0.0005, vy: -0.0004 - Math.random() * 0.0006 });
  }

  function setFocusedStation(idx, panToIt) {
    focusedIdx = idx;
    var st = STATIONS[idx];
    if (panToIt) {
      targetPanNorm = st.pan;
      if (panWorld) {
        panWorld.classList.add('b84-zooming');
        setTimeout(function () { if (panWorld) panWorld.classList.remove('b84-zooming'); }, 440);
      }
    }
    for (var i = 0; i < STATIONS.length; i++) {
      var pin = document.getElementById('b84-pin-' + i);
      var chip = document.getElementById('b84-chip-' + i);
      if (pin) pin.classList.toggle('b84-pin-focused', i === idx);
      if (chip) chip.classList.toggle('active', i === idx);
    }
    renderFocusedBar();
  }

  function renderFocusedBar() {
    var st = STATIONS[focusedIdx];
    var icoEl = document.getElementById('b84-st-ico');
    var titEl = document.getElementById('b84-st-title');
    var subEl = document.getElementById('b84-st-sub');
    var ctaEl = document.getElementById('b84-st-cta');
    if (icoEl) icoEl.textContent = st.icon;
    if (titEl) titEl.textContent = st.title;
    if (subEl) subEl.textContent = st.sub;
    if (ctaEl) ctaEl.textContent = st.cta;
  }

  window.b84SelectStation = function (idx) {
    FuranchoAudio.woodTap();
    setFocusedStation(idx, true);
  };

  window.b84OpenFocusedStation = function () {
    FuranchoAudio.woodTap();
    var st = STATIONS[focusedIdx];
    if (st && typeof st.open === 'function') st.open();
  };

  window.b84OnPinTap = function (idx, ev) {
    if (ev) ev.stopPropagation();
    if (focusedIdx === idx) {
      window.b84OpenFocusedStation();
    } else {
      FuranchoAudio.woodTap();
      setFocusedStation(idx, true);
    }
  };

  window.b84ToggleViva = function (btn) {
    vivaMode = !vivaMode;
    FuranchoAudio.woodTap();
    var img = document.getElementById('b84-scene-img');
    if (img) img.src = vivaMode ? '/assets/baixo84/adega_1984_viva.jpg' : '/assets/baixo84/adega_1984.jpg';
    if (btn) btn.classList.toggle('active', vivaMode);
  };

  window.b84ToggleExpand = function (btn) {
    FuranchoAudio.woodTap();
    var shell = document.getElementById('baixo84-stage-shell');
    if (!shell) return;
    var exp = shell.classList.toggle('b84-expanded');
    if (btn) btn.textContent = exp ? '🗕 Normal' : '⛶ Ampliar';
    resizeFxCanvas();
  };

  window.b84ToggleSound = function (btn) {
    var muted = FuranchoAudio.toggleMute();
    if (btn) btn.textContent = muted ? '🔇' : '🔊';
  };

  function mountBaixo84Stage() {
    var profileScreen = document.getElementById('screen-profile');
    if (!profileScreen || document.getElementById('baixo84-stage-shell')) return;

    var oldPoster = profileScreen.querySelector('.cin-poster');
    if (!oldPoster) return;

    var pinsHtml = STATIONS.map(function (st, i) {
      return '<button type="button" class="b84-pin' + (i === focusedIdx ? ' b84-pin-focused' : '') + '" id="b84-pin-' + i + '" style="left:' + st.left + '; top:' + st.top + ';" onclick="b84OnPinTap(' + i + ', event)" aria-label="' + st.pinLabel + '">' +
        '<span>' + st.icon + '</span>' +
        '<span class="b84-pin-lbl">' + st.pinLabel + ' ›</span>' +
      '</button>';
    }).join('');

    var tabsHtml = STATIONS.map(function (st, i) {
      return '<button type="button" class="b84-cam-chip' + (i === focusedIdx ? ' active' : '') + '" id="b84-chip-' + i + '" onclick="b84SelectStation(' + i + ')">' + st.tab + '</button>';
    }).join('');

    var shell = document.createElement('div');
    shell.id = 'baixo84-stage-shell';
    shell.className = 'b84-stage-shell';
    shell.innerHTML =
      '<div class="b84-bezel-top">' +
        '<div class="b84-era-badge">' +
          '<span class="b84-era-dot" id="b84-era-dot"></span>' +
          '<span id="b84-era-label">O BAIXO · 1984</span>' +
        '</div>' +
        '<div class="b84-hud-controls">' +
          '<button type="button" class="b84-ctrl-btn" onclick="b84ToggleViva(this)">👥 Ambiente</button>' +
          '<button type="button" class="b84-ctrl-btn" onclick="b84ToggleExpand(this)">⛶ Ampliar</button>' +
          '<button type="button" class="b84-ctrl-btn" id="b84-sound-btn" onclick="b84ToggleSound(this)">' + (soundMuted ? '🔇' : '🔊') + '</button>' +
        '</div>' +
      '</div>' +

      '<div class="b84-viewport" id="baixo84-viewport">' +
        '<div class="b84-pan-world" id="baixo84-pan-world">' +
          '<img id="b84-scene-img" class="b84-scene-img" src="/assets/baixo84/adega_1984.jpg" alt="O Baixo da Casa 1984" />' +
          '<canvas id="baixo84-fx-canvas" class="b84-fx-canvas" width="680" height="340"></canvas>' +
          pinsHtml +
        '</div>' +
        '<div class="b84-vignette"></div>' +
      '</div>' +

      '<div class="b84-bezel-Tray">' +
        '<div class="b84-room-tabs">' + tabsHtml + '</div>' +
        '<div class="b84-station-bar">' +
          '<div class="b84-st-left">' +
            '<span class="b84-st-ico" id="b84-st-ico">📒</span>' +
            '<div class="b84-st-meta">' +
              '<div class="b84-st-title" id="b84-st-title">Libreta do Corcho · 1984</div>' +
              '<div class="b84-st-sub" id="b84-st-sub">Cargando saldo...</div>' +
            '</div>' +
          '</div>' +
          '<button type="button" class="b84-st-cta" id="b84-st-cta" onclick="b84OpenFocusedStation()">Abrir Libreta ›</button>' +
        '</div>' +
      '</div>';

    oldPoster.parentNode.replaceChild(shell, oldPoster);

    panWorld = document.getElementById('baixo84-pan-world');
    fxCanvas = document.getElementById('baixo84-fx-canvas');
    fxCtx = fxCanvas ? fxCanvas.getContext('2d') : null;
    resizeFxCanvas();
    window.addEventListener('resize', resizeFxCanvas);

    var vp = document.getElementById('baixo84-viewport');
    var dragging = false, startX = 0, startPan = 0;
    vp.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      dragging = true;
      startX = e.clientX;
      startPan = targetPanNorm;
    });
    window.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      targetPanNorm = Math.max(-1, Math.min(1, startPan - dx / 145));
      var nearest = 0, bestDist = 999;
      for (var i = 0; i < STATIONS.length; i++) {
        var dist = Math.abs(STATIONS[i].pan - targetPanNorm);
        if (dist < bestDist) { bestDist = dist; nearest = i; }
      }
      if (nearest !== focusedIdx) setFocusedStation(nearest, false);
    }, { passive: true });
    window.addEventListener('pointerup', function () { dragging = false; }, { passive: true });

    window.addEventListener('deviceorientation', function (e) {
      if (dragging || e.gamma == null) return;
      targetTiltY = Math.max(-3.5, Math.min(3.5, e.gamma / 8));
    }, { passive: true });

    mountBottomDock84();
    mountLibreta84Modal();
    injectSheetTopbars();
    patchGlobalModalFunctions();
    renderFocusedBar();
    startCellarLoop();
    setInterval(syncCellarLiveBadges, 1200);
    setTimeout(syncCellarLiveBadges, 350);
  }

  function resizeFxCanvas() {
    if (!fxCanvas || !panWorld) return;
    fxCanvas.width = Math.min(760, Math.max(460, panWorld.clientWidth));
    fxCanvas.height = Math.min(400, Math.max(240, panWorld.clientHeight));
  }

  function startCellarLoop() {
    if (stageRunning) return;
    stageRunning = true;
    var t = 0;

    function frame() {
      var profileActive = document.getElementById('screen-profile')?.classList.contains('active');
      var anyModalOpen = !!B84Nav.getActiveSection();
      if (document.visibilityState === 'visible' && profileActive && !anyModalOpen && panWorld) {
        t += 0.016;
        panNorm += (targetPanNorm - panNorm) * 0.11;
        tiltY += (targetTiltY - tiltY) * 0.08;

        var maxShiftPct = 17.5;
        var tx = (-panNorm * maxShiftPct).toFixed(3);
        var ry = (panNorm * -3.0 + tiltY * 0.55).toFixed(2);
        panWorld.style.transform = 'translate3d(' + tx + '%, 0, 0) rotateY(' + ry + 'deg)';

        if (fxCtx && fxCanvas) {
          var W = fxCanvas.width, H = fxCanvas.height;
          fxCtx.clearRect(0, 0, W, H);

          fxCtx.strokeStyle = 'rgba(195, 222, 242, 0.34)';
          fxCtx.lineWidth = 1.1;
          for (var i = 0; i < rainDrops.length; i++) {
            var rd = rainDrops[i];
            rd.y += rd.sp;
            if (rd.y > 0.84) { rd.y = 0.16; rd.x = 0.05 + Math.random() * 0.14; }
            var rx = rd.x * W, ry0 = rd.y * H;
            fxCtx.beginPath(); fxCtx.moveTo(rx, ry0); fxCtx.lineTo(rx - 2, ry0 + 11); fxCtx.stroke();
          }

          var flicker = 0.93 + 0.07 * Math.sin(t * 7.1) * Math.cos(t * 3.0);
          var lx = W * 0.602, ly = H * 0.21;
          var cone = fxCtx.createRadialGradient(lx, ly, 4, lx - W * 0.04, H * 0.65, W * 0.34);
          cone.addColorStop(0, 'rgba(255, 232, 175, ' + (0.26 * flicker).toFixed(3) + ')');
          cone.addColorStop(0.45, 'rgba(235, 168, 72, ' + (0.09 * flicker).toFixed(3) + ')');
          cone.addColorStop(1, 'rgba(0, 0, 0, 0)');
          fxCtx.fillStyle = cone;
          fxCtx.fillRect(W * 0.22, 0, W * 0.72, H);

          var qx = W * 0.752, qy = H * 0.585;
          for (var f = 0; f < 5; f++) {
            var fx = qx + (f - 2) * 4.5 + Math.sin(t * 8 + f) * 2;
            var fh = 11 + Math.sin(t * 11 + f * 1.7) * 5;
            var fg = fxCtx.createLinearGradient(fx, qy, fx, qy - fh);
            fg.addColorStop(0, 'rgba(59, 130, 246, 0.72)');
            fg.addColorStop(0.65, 'rgba(147, 197, 253, 0.42)');
            fg.addColorStop(1, 'rgba(255, 255, 255, 0)');
            fxCtx.fillStyle = fg;
            fxCtx.beginPath(); fxCtx.ellipse(fx, qy - fh * 0.45, 3.5, fh * 0.55, 0, 0, Math.PI * 2); fxCtx.fill();
          }

          for (var k = 0; k < dustMotes.length; k++) {
            var dm = dustMotes[k];
            dm.x += dm.vx; dm.y += dm.vy;
            if (dm.y < 0.10) { dm.y = 0.85; dm.x = 0.25 + Math.random() * 0.65; }
            fxCtx.fillStyle = 'rgba(255, 230, 170, 0.32)';
            fxCtx.beginPath(); fxCtx.arc(dm.x * W, dm.y * H, dm.r, 0, Math.PI * 2); fxCtx.fill();
          }
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function syncCellarLiveBadges() {
    var profileActive = document.getElementById('screen-profile')?.classList.contains('active');
    var dock = document.getElementById('baixo84-dock');
    // Ocultar el dock solo durante el sorteo de pantalla completa (#raffle-modal)
    var liveRaffleOpen = isModalVisible('raffle-modal');
    if (dock) dock.classList.toggle('visible', !!(profileActive && !liveRaffleOpen));
    B84Nav.syncDockActive();
    if (!profileActive) return;

    var inside = isUserInside();
    var eraDot = document.getElementById('b84-era-dot');
    var eraLbl = document.getElementById('b84-era-label');
    var pinPorta = document.getElementById('b84-pin-0');
    var dockFicharLbl = document.getElementById('b84-dock-fichar-lbl');
    var dockFicharDot = document.getElementById('b84-dock-fichar-dot');

    if (eraDot) eraDot.classList.toggle('inside', inside);
    if (eraLbl) eraLbl.textContent = inside ? 'DENTRO · 1984' : (window.isVacationMode ? 'VACACIÓNS · 1984' : 'O BAIXO · 1984');
    if (pinPorta) pinPorta.classList.toggle('b84-hs-live', inside);
    STATIONS[0].sub = inside ? '🟢 Sesión activa · Pulsa para rexistrar saída' : '📷 Escanea o QR da porta ao chegar';
    STATIONS[0].cta = inside ? 'Saír ›' : 'Fichar ›';
    if (dockFicharLbl) dockFicharLbl.textContent = inside ? 'Saír' : 'Fichar';
    if (dockFicharDot) dockFicharDot.style.display = inside ? 'block' : 'none';

    var balText = document.getElementById('corcho-user-balance')?.textContent || '0';
    STATIONS[2].sub = balText + ' $CORCHO · Canxes, Packs e Movementos';
    var pendingSec = document.getElementById('corcho-pending-section');
    var hasPendingCorcho = !!(pendingSec && pendingSec.style.display !== 'none' && pendingSec.innerHTML.trim());
    var dockBancoDot = document.getElementById('b84-dock-banco-dot');
    if (dockBancoDot) dockBancoDot.style.display = hasPendingCorcho ? 'block' : 'none';

    var visits = document.getElementById('visit-count-display')?.textContent || '0';
    var nextHint = document.getElementById('next-level-text')?.textContent || 'Ver niveis VIP';
    STATIONS[3].sub = visits + (visits === '1' ? ' visita · ' : ' visitas · ') + nextHint;

    var chavePill = document.getElementById('chave-pill');
    var raffleLive = document.getElementById('raffle-live-dot');
    var acceptBanner = document.getElementById('accept-prize-banner');
    var pinSorteos = document.getElementById('b84-pin-1');
    var dockChaveDot = document.getElementById('b84-dock-chave-dot');

    var wonLive = !!(acceptBanner && acceptBanner.style.display !== 'none');
    var chaveAlert = !!(chavePill && chavePill.style.display !== 'none' && chavePill.textContent.trim());
    STATIONS[1].sub = wonLive ? '🏆 ¡Tes un premio activo esperando!' : (chaveAlert ? '🔔 A Chave Semanal está aberta!' : 'Consulta A Chave Semanal e sorteos');
    if (pinSorteos) pinSorteos.classList.toggle('b84-hs-alert', wonLive || chaveAlert);
    if (dockChaveDot) dockChaveDot.style.display = (wonLive || chaveAlert || (raffleLive && raffleLive.style.display !== 'none')) ? 'block' : 'none';

    renderFocusedBar();
  }

  // ── 4. DOCK PERSISTENTE DE NAVEGACIÓN ENTRE MENÚS ──────────────────────────
  function mountBottomDock84() {
    if (document.getElementById('baixo84-dock')) return;
    var dock = document.createElement('nav');
    dock.id = 'baixo84-dock';
    dock.setAttribute('aria-label', 'Navegación principal do Furancho');
    dock.innerHTML =
      '<button type="button" class="b84-dock-btn" id="b84-dock-btn-fichar" onclick="B84Nav.dockTap(\'fichar\')">' +
        '<span class="b84-dock-dot" id="b84-dock-fichar-dot"></span>' +
        '<span class="b84-dock-ico">🌿</span><span class="b84-dock-lbl" id="b84-dock-fichar-lbl">Fichar</span>' +
      '</button>' +
      '<button type="button" class="b84-dock-btn" id="b84-dock-btn-carne" onclick="B84Nav.dockTap(\'carne\')">' +
        '<span class="b84-dock-ico">🪪</span><span class="b84-dock-lbl">Carné</span>' +
      '</button>' +
      '<button type="button" class="b84-dock-btn" id="b84-dock-btn-banco" onclick="B84Nav.dockTap(\'banco\')">' +
        '<span class="b84-dock-dot" id="b84-dock-banco-dot"></span>' +
        '<span class="b84-dock-ico">📒</span><span class="b84-dock-lbl">Banco</span>' +
      '</button>' +
      '<button type="button" class="b84-dock-btn" id="b84-dock-btn-xogos" onclick="B84Nav.dockTap(\'xogos\')">' +
        '<span class="b84-dock-ico">🕹️</span><span class="b84-dock-lbl">Xogos</span>' +
      '</button>' +
      '<button type="button" class="b84-dock-btn" id="b84-dock-btn-chave" onclick="B84Nav.dockTap(\'chave\')">' +
        '<span class="b84-dock-dot" id="b84-dock-chave-dot"></span>' +
        '<span class="b84-dock-ico">🔑</span><span class="b84-dock-lbl">Chave</span>' +
      '</button>' +
      '<button type="button" class="b84-dock-btn" id="b84-dock-btn-museo" onclick="B84Nav.dockTap(\'museo\')">' +
        '<span class="b84-dock-ico">🏺</span><span class="b84-dock-lbl">Museo</span>' +
      '</button>' +
      '<button type="button" class="b84-dock-btn" id="b84-dock-btn-ruta" onclick="B84Nav.dockTap(\'ruta\')">' +
        '<span class="b84-dock-ico">🗺️</span><span class="b84-dock-lbl">Ruta</span>' +
      '</button>';
    document.body.appendChild(dock);
  }

  // ── 5. LIBRETA DE AFORRO DO CORCHO 1984 ────────────────────────────────────
  var _libretaFilter = 'all';
  var _libretaHistoryCache = [];

  function mountLibreta84Modal() {
    if (document.getElementById('b84-libreta-modal')) return;
    var m = document.createElement('div');
    m.id = 'b84-libreta-modal';
    m.className = 'b84-passbook-modal';
    m.onclick = function (e) { if (e.target === m) closeLibreta84Modal(); };
    m.innerHTML =
      '<div class="b84-passbook-cover">' +
        '<div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px 10px; color:#F3D58D;">' +
          '<div style="display:flex; align-items:center; gap:8px;">' +
            '<span style="font-size:18px;">📒</span>' +
            '<div>' +
              '<div style="font-family:\'Playfair Display\',serif; font-size:16px; font-weight:900; letter-spacing:0.6px;">LIBRETA DO CORCHO · 1984</div>' +
              '<div style="font-size:10px; opacity:0.82; letter-spacing:1px; text-transform:uppercase;">Caixa Furancheira de Aforros</div>' +
            '</div>' +
          '</div>' +
          '<button type="button" onclick="closeLibreta84Modal()" style="background:rgba(255,255,255,0.12); border:1px solid rgba(243,213,141,0.4); color:#FFF; width:30px; height:30px; border-radius:50%; cursor:pointer; font-weight:900;">✕</button>' +
        '</div>' +
        '<div class="b84-passbook-page">' +
          '<div style="display:flex; align-items:baseline; justify-content:space-between; border-bottom:2px double rgba(139,10,26,0.3); padding-bottom:10px; margin-bottom:12px;">' +
            '<div>' +
              '<div style="font-size:10px; font-weight:800; color:#6E4720; text-transform:uppercase; letter-spacing:1px;">Saldo dispoñible</div>' +
              '<div id="b84-libreta-status" style="font-size:11.5px; font-weight:800; color:#8B0A1A; margin-top:2px;">Socio Furancheiro</div>' +
            '</div>' +
            '<div style="text-align:right;">' +
              '<span id="b84-libreta-bal" style="font-family:\'Playfair Display\',serif; font-size:30px; font-weight:900; color:#8B0A1A; line-height:1;">0</span>' +
              '<span style="font-size:10px; font-weight:900; color:#9E7220; display:block; letter-spacing:1px;">$CORCHO</span>' +
            '</div>' +
          '</div>' +

          '<div id="b84-libreta-pending" style="display:none; margin-bottom:12px;"></div>' +

          '<div style="display:grid; grid-template-columns:repeat(2,1fr); gap:8px; margin-bottom:14px;">' +
            '<button type="button" onclick="openCorchoItemsModal()" style="padding:11px 10px; border-radius:12px; border:1.5px solid #15803d; background:linear-gradient(145deg,#dcfce7,#bbf7d0); color:#14532d; font-weight:800; font-size:12.5px; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">🎁 Canxear na Barra</button>' +
            '<button type="button" onclick="openCorchoPacksModal()" style="padding:11px 10px; border-radius:12px; border:1.5px solid #b45309; background:linear-gradient(145deg,#fef3c7,#fde68a); color:#78350f; font-weight:800; font-size:12.5px; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">💶 Recargar Packs</button>' +
            '<button type="button" onclick="openCorchoTransferModal()" style="padding:10px; border-radius:12px; border:1.5px solid #5E3418; background:#EFE4CE; color:#2B1506; font-weight:800; font-size:12px; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">🔄 Traspasar NFT</button>' +
            '<button type="button" onclick="openCorchoInfoModal()" style="padding:10px; border-radius:12px; border:1.5px solid rgba(139,10,26,0.35); background:#FFFDF8; color:#8B0A1A; font-weight:800; font-size:12px; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">📜 Regras FIFO</button>' +
          '</div>' +

          '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; gap:6px;">' +
            '<span style="font-family:\'Courier New\',monospace; font-size:11px; font-weight:900; color:#3A1F0E; text-transform:uppercase;">Asentos da Libreta</span>' +
            '<div style="display:flex; gap:4px;">' +
              '<button type="button" onclick="setLibretaFilter(\'all\')" id="b84-lf-all" style="padding:3px 8px; font-size:10px; font-weight:800; border-radius:6px; border:1px solid #8B0A1A; background:#8B0A1A; color:#FFF; cursor:pointer;">Todos</button>' +
              '<button type="button" onclick="setLibretaFilter(\'in\')" id="b84-lf-in" style="padding:3px 8px; font-size:10px; font-weight:800; border-radius:6px; border:1px solid rgba(94,52,24,0.3); background:transparent; color:#5E3418; cursor:pointer;">+Entradas</button>' +
              '<button type="button" onclick="setLibretaFilter(\'out\')" id="b84-lf-out" style="padding:3px 8px; font-size:10px; font-weight:800; border-radius:6px; border:1px solid rgba(94,52,24,0.3); background:transparent; color:#5E3418; cursor:pointer;">-Saídas</button>' +
            '</div>' +
          '</div>' +

          '<div id="b84-libreta-ledger" style="max-height:190px; overflow-y:auto; display:flex; flex-direction:column; gap:5px; font-family:\'Courier New\',monospace;">' +
            '<p style="font-size:11px; text-align:center; color:#6E4720;">Cargando movementos...</p>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
  }

  window.openLibreta84Modal = async function () {
    mountLibreta84Modal();
    B84Nav.closeAll('b84-libreta-modal');
    document.getElementById('b84-libreta-modal').style.display = 'flex';
    B84Nav.syncDockActive();

    var balEl = document.getElementById('corcho-user-balance');
    var stEl = document.getElementById('corcho-wealth-status');
    document.getElementById('b84-libreta-bal').textContent = balEl ? balEl.textContent : '0';
    document.getElementById('b84-libreta-status').textContent = stEl ? stEl.textContent : 'Socio do Furancho';

    var pendSrc = document.getElementById('corcho-pending-section');
    var pendDst = document.getElementById('b84-libreta-pending');
    if (pendSrc && pendSrc.style.display !== 'none' && pendSrc.innerHTML.trim()) {
      pendDst.style.display = 'block';
      pendDst.innerHTML = pendSrc.innerHTML;
    } else {
      pendDst.style.display = 'none';
    }

    var w = activeWallet();
    if (!w) return;
    try {
      var r = await fetch('/api/corcho/balance?wallet=' + encodeURIComponent(w));
      var d = await r.json();
      if (d && typeof d.balance === 'number') {
        document.getElementById('b84-libreta-bal').textContent = d.balance.toLocaleString();
        _libretaHistoryCache = d.history || [];
        renderLibretaLedger();
      }
    } catch (_) {}
  };

  window.closeLibreta84Modal = function () {
    B84Nav.closeAll();
  };

  window.setLibretaFilter = function (f) {
    _libretaFilter = f;
    ['all', 'in', 'out'].forEach(function (k) {
      var b = document.getElementById('b84-lf-' + k);
      if (!b) return;
      var act = k === f;
      b.style.background = act ? '#8B0A1A' : 'transparent';
      b.style.color = act ? '#FFF' : '#5E3418';
      b.style.borderColor = act ? '#8B0A1A' : 'rgba(94,52,24,0.3)';
    });
    renderLibretaLedger();
  };

  function renderLibretaLedger() {
    var box = document.getElementById('b84-libreta-ledger');
    if (!box) return;
    var rows = (_libretaHistoryCache || []).filter(function (tx) {
      if (_libretaFilter === 'in') return tx.amount > 0;
      if (_libretaFilter === 'out') return tx.amount < 0;
      return true;
    });
    if (!rows.length) {
      box.innerHTML = '<p style="font-size:11px; text-align:center; color:#6E4720; padding:14px 0;">Sen apuntes nesta categoría.</p>';
      return;
    }
    box.innerHTML = rows.map(function (tx) {
      var pos = tx.amount > 0;
      var dt = (tx.created_at || '').slice(5, 16).replace('T', ' ');
      var desc = String(tx.description || tx.type || '').replace(/</g, '&lt;');
      return '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 6px; border-radius:6px; background:rgba(255,255,255,0.55); border:1px solid rgba(94,52,24,0.12);">' +
        '<div style="min-width:0; flex:1;">' +
          '<div style="font-size:11px; font-weight:700; color:#23140B; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + desc + '</div>' +
          '<div style="font-size:9.5px; color:#785A3C;">' + dt + '</div>' +
        '</div>' +
        '<div style="font-size:12px; font-weight:900; color:' + (pos ? '#15803d' : '#991b1b') + '; white-space:nowrap;">' + (pos ? '+' : '') + tx.amount + '</div>' +
      '</div>';
    }).join('');
  }

  // ── 6. REMODELACIÓN DE LOS 8 MINIJUEGOS Y SU FLUJO INTERNO ─────────────────
  function activeWallet() {
    return window.userWalletAddress || localStorage.getItem('furancho_wallet_address') || '';
  }

  function refreshBalanceQuietly() {
    if (typeof window.loadCorchoBalance === 'function') window.loadCorchoBalance();
    setTimeout(syncCellarLiveBadges, 300);
  }

  function upgradeAllMinigames84() {
    window.openMinigamesModal = function () {
      FuranchoAudio.woodTap();
      B84Nav.closeAll('minigames-menu-modal');
      var modal = document.getElementById('minigames-menu-modal');
      if (!modal) return;
      modal.style.display = 'flex';
      B84Nav.syncDockActive();

      var hdrs = { 'wallet-address': activeWallet() };

      function markExhausted(card, exhausted, msg) {
        if (!card) return;
        card.style.display = 'block';
        card.classList.toggle('b84-game-exhausted', !!exhausted);
        var oldStamp = card.querySelector('.b84-stamp-done');
        if (oldStamp) oldStamp.remove();
        if (exhausted) {
          var st = document.createElement('div');
          st.className = 'b84-stamp-done';
          st.textContent = msg || '✓ Xogado hoxe · Volve mañá';
          card.appendChild(st);
        }
      }

      // Poblar también los premios máximos de cada juego desde /api/corcho/rates
      fetch('/api/corcho/rates').then(function (r) { return r.json(); }).then(function (rates) {
        var qP = document.getElementById('mg-queimada-prize');
        if (qP) qP.textContent = '🏆 Premio: Hasta ' + ((rates.queimadaEntryCost || 15) * (rates.queimadaMult21 || 3)) + ' $CORCHO';
        var raP = document.getElementById('mg-rasca-prize');
        if (raP) raP.textContent = '🏆 Premio: Hasta ' + (rates.rascaPrize1 || 100) + ' $CORCHO';
        var trP = document.getElementById('mg-traga-prize');
        if (trP) trP.textContent = '🏆 Premio: Hasta ' + (rates.tragaPrize3 || 100) + ' $CORCHO';
        var chP = document.getElementById('mg-chave-prize');
        if (chP) chP.textContent = '🏆 Premio: Hasta ' + (rates.chavePrizePleno || 50) + ' $CORCHO';
        var tvP = document.getElementById('mg-trivial-prize');
        if (tvP) tvP.textContent = '🏆 Premio: ' + (rates.trivialPrize || 100) + ' $CORCHO';
      }).catch(function () {});

      fetch('/api/minigames/enxebre/status', { headers: hdrs }).then(function (r) { return r.json(); }).then(function (d) {
        var card = document.getElementById('mg-enxebre-card');
        if (!card) return;
        var costEl = document.getElementById('mg-enxebre-cost');
        if (costEl) costEl.textContent = d.vacationMode ? '💸 🏖️ Gratis' : (d.entryCost > 0 ? '💸 Coste: ' + d.entryCost + ' $CORCHO' : '💸 Coste: Gratis');
        var prizeEl = document.getElementById('mg-enxebre-prize');
        if (prizeEl && d.maxPrize) prizeEl.textContent = '🏆 Premio: Hasta ' + d.maxPrize + ' $CORCHO';
        markExhausted(card, !!d.playedToday, '✓ Palabra do día completada · Volve mañá');
      }).catch(function () {});

      fetch('/api/minigames/cunca/status', { headers: hdrs }).then(function (r) { return r.json(); }).then(function (d) {
        var card = document.getElementById('mg-cunca-card');
        if (card) card.style.display = d.hasCunca ? 'block' : 'none';
      }).catch(function () {});

      fetch('/api/minigames/ruleta/status', { headers: hdrs }).then(function (r) { return r.json(); }).then(function (d) {
        var card = document.getElementById('mg-ruleta-card');
        if (!d.enabled) { if (card) card.style.display = 'none'; return; }
        var left = Math.max(0, (d.maxPlays || 0) - (d.playsToday || 0));
        var costStr = d.vacationMode ? '🏖️ Gratis' : d.entryCost + ' $CORCHO';
        var descEl = document.getElementById('mg-ruleta-desc');
        if (descEl) descEl.textContent = left > 0 ? ('Xira a roda da feira (' + costStr + '). Quédanche ' + left + ' tiradas hoxe.') : 'Tiradas esgotadas por hoxe.';
        var costEl = document.getElementById('mg-ruleta-cost');
        if (costEl) costEl.textContent = d.vacationMode ? '💸 🏖️ Gratis' : '💸 Coste: ' + d.entryCost + ' $CORCHO';
        var prizeEl = document.getElementById('mg-ruleta-prize');
        if (prizeEl && d.slices) prizeEl.textContent = '🏆 Premio: Hasta ' + Math.max.apply(null, d.slices.map(function (s) { return s.prize || 0; })) + ' $CORCHO';
        markExhausted(card, !d.canPlay, '✓ Tiradas de hoxe feitas · Volve mañá');
      }).catch(function () {});

      fetch('/api/minigames/queimada/status', { headers: hdrs }).then(function (r) { return r.json(); }).then(function (d) {
        var card = document.getElementById('mg-queimada-card');
        if (!d.enabled) { if (card) card.style.display = 'none'; return; }
        var left = Math.max(0, (d.maxPlays || 0) - (d.playsToday || 0));
        var costStr = d.vacationMode ? '🏖️ Gratis' : d.entryCost + ' $CORCHO';
        var descEl = document.getElementById('mg-queimada-desc');
        if (descEl) descEl.textContent = d.canPlay ? ('Prepara o conxuro no pote (' + costStr + '). Quédanche ' + (d.activeSession ? '1 en curso' : left) + ' hoxe.') : 'Queimadas esgotadas hoxe.';
        var costEl = document.getElementById('mg-queimada-cost');
        if (costEl) costEl.textContent = d.vacationMode ? '💸 🏖️ Gratis' : '💸 Coste: ' + d.entryCost + ' $CORCHO';
        markExhausted(card, !d.canPlay, '✓ Pote apagado ata mañá');
      }).catch(function () {});

      var descs = {
        rasca: 'Rasca a película de corcho e ouro real.',
        traga: 'Recreativa de bar A Ría \'85 con 3 tambores.',
        chave: 'Lanza o pellote de ferro no terreiro 3D.',
        trivial: 'Concurso da parroquia · 3 preguntas sen fallo.'
      };
      ['rasca', 'traga', 'chave', 'trivial'].forEach(function (g) {
        var card = document.getElementById('mg-' + g + '-card');
        if (!card) return;
        fetch('/api/minigames/' + g + '/status', { headers: hdrs }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d.enabled) { card.style.display = 'none'; return; }
          var costStr = d.vacationMode ? '🏖️ Gratis' : d.entryCost + ' $CORCHO';
          var descEl = document.getElementById('mg-' + g + '-desc');
          if (descEl) descEl.textContent = d.playsLeft > 0 ? (descs[g] + ' (' + costStr + ' · Quedan ' + d.playsLeft + ')') : descs[g];
          var costEl = document.getElementById('mg-' + g + '-cost');
          if (costEl) costEl.textContent = d.vacationMode ? '💸 🏖️ Gratis' : '💸 Coste: ' + d.entryCost + ' $CORCHO';
          markExhausted(card, d.playsLeft <= 0, '✓ Esgotado hoxe · Volve mañá');
        }).catch(function () {});
      });
    };

    window.closeMinigamesModal = function () {
      B84Nav.closeAll();
    };

    // Envolver apertura de O Enxebre y Ruleta para que cierren limpio cualquier otro modal antes
    var origOpenEnxebre = window.openEnxebre;
    if (typeof origOpenEnxebre === 'function') {
      window.openEnxebre = function () {
        B84Nav.closeAll('enxebre-modal');
        origOpenEnxebre();
        B84Nav.syncDockActive();
      };
    }
    var origOpenRuleta = window.openRuletaModal;
    if (typeof origOpenRuleta === 'function') {
      window.openRuletaModal = function () {
        B84Nav.closeAll('ruleta-modal');
        origOpenRuleta();
        B84Nav.syncDockActive();
      };
    }

    // Envolver apertura de Rasca y Traga para cerrar minigames-menu-modal antes (evitar doble fondo borroso)
    var origOpenRasca = window.openRascaModal;
    if (typeof origOpenRasca === 'function') {
      window.openRascaModal = function () {
        B84Nav.closeAll('rasca-modal');
        origOpenRasca();
        B84Nav.syncDockActive();
      };
    }
    var origOpenTraga = window.openTragaModal;
    if (typeof origOpenTraga === 'function') {
      window.openTragaModal = function () {
        B84Nav.closeAll('traga-modal');
        origOpenTraga();
        B84Nav.syncDockActive();
      };
    }

    // ── A CHAVE NO TERREIRO 3D ──
    var chaveRaf = null, chaveAimT = 0, chaveFlight = null, chaveSparkParticles = [];
    var chaveBladeSpin = 0, chaveStateReady = false;

    function ensureChave3DCanvas() {
      var modalCard = document.querySelector('#chave-virtual-modal > div');
      if (!modalCard || document.getElementById('b84-chave-canvas')) return;
      var oldIcon = document.getElementById('chave-icon');
      var oldBar = oldIcon ? oldIcon.nextElementSibling : null;
      if (oldIcon) oldIcon.style.display = 'none';
      if (oldBar) oldBar.style.display = 'none';

      var wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative; width:100%; border-radius:12px; overflow:hidden; border:1.5px solid rgba(200,155,60,0.45); margin-bottom:12px; background:#141C16;';
      wrap.innerHTML = '<canvas id="b84-chave-canvas" width="292" height="186" style="width:100%; height:186px; display:block; cursor:pointer;"></canvas>';
      var msgEl = document.getElementById('chave-msg');
      modalCard.insertBefore(wrap, msgEl);

      var cv = wrap.querySelector('canvas');
      var downY = null;
      cv.addEventListener('pointerdown', function (e) { downY = e.clientY; });
      cv.addEventListener('pointerup', function (e) {
        if (!chaveStateReady || chaveFlight) return;
        if (downY !== null && (downY - e.clientY > 18 || Math.abs(downY - e.clientY) < 10)) {
          window.throwChave();
        }
        downY = null;
      });
    }

    function renderChave3DLoop() {
      if (!isModalVisible('chave-virtual-modal')) { chaveRaf = null; return; }
      var cv = document.getElementById('b84-chave-canvas');
      if (!cv) { chaveRaf = null; return; }
      var c = cv.getContext('2d');
      var W = cv.width, H = cv.height;
      chaveAimT += 0.042;
      chaveBladeSpin *= 0.94;

      var sky = c.createLinearGradient(0, 0, 0, 68);
      sky.addColorStop(0, '#1B2A38'); sky.addColorStop(1, '#3B4238');
      c.fillStyle = sky; c.fillRect(0, 0, W, 68);

      c.fillStyle = '#4A463F'; c.fillRect(0, 46, W, 26);
      for (var sx = 0; sx < W; sx += 26) {
        c.strokeStyle = '#26231E'; c.strokeRect(sx, 47, 25, 12);
        c.strokeRect(sx - 10, 59, 25, 12);
      }

      var earth = c.createLinearGradient(0, 70, 0, H);
      earth.addColorStop(0, '#5E442C'); earth.addColorStop(1, '#382515');
      c.fillStyle = earth; c.fillRect(0, 70, W, H - 70);
      c.strokeStyle = 'rgba(243,213,141,0.22)'; c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(W * 0.30, 72); c.lineTo(W * 0.08, H);
      c.moveTo(W * 0.70, 72); c.lineTo(W * 0.92, H);
      c.stroke();

      var tx = W * 0.5, ty = 96;
      c.fillStyle = '#78716C';
      c.fillRect(tx - 14, ty + 6, 28, 12);
      c.strokeStyle = '#CBD5E1'; c.lineWidth = 3.2;
      c.beginPath(); c.moveTo(tx, ty + 8); c.lineTo(tx, ty - 22); c.stroke();
      var wingW = 19 * Math.cos(chaveBladeSpin);
      c.strokeStyle = '#E2E8F0'; c.lineWidth = 4;
      c.beginPath(); c.moveTo(tx - wingW, ty - 14); c.lineTo(tx + wingW, ty - 14); c.stroke();
      c.beginPath(); c.moveTo(tx - wingW * 0.7, ty - 4); c.lineTo(tx + wingW * 0.7, ty - 4); c.stroke();

      var currentTiming = 50 + Math.sin(chaveAimT) * 50;
      if (chaveStateReady && !chaveFlight) {
        var aimX = W * 0.18 + (currentTiming / 100) * (W * 0.64);
        var isSweet = currentTiming >= 44 && currentTiming <= 56;
        c.strokeStyle = isSweet ? 'rgba(74, 222, 128, 0.75)' : 'rgba(250, 204, 21, 0.45)';
        c.setLineDash([4, 4]);
        c.beginPath(); c.moveTo(W * 0.5, H - 22); c.lineTo(aimX, ty); c.stroke();
        c.setLineDash([]);
        c.beginPath(); c.arc(aimX, ty, 8, 0, Math.PI * 2);
        c.strokeStyle = isSweet ? '#4ADE80' : '#FACC15'; c.lineWidth = 2; c.stroke();
        c.fillStyle = '#475569'; c.strokeStyle = '#E2E8F0'; c.lineWidth = 2;
        c.beginPath(); c.ellipse(W * 0.5, H - 20, 18, 9, 0, 0, Math.PI * 2); c.fill(); c.stroke();
      }

      if (chaveFlight) {
        chaveFlight.p += 0.048;
        var p = Math.min(1, chaveFlight.p);
        var px = W * 0.5 + (chaveFlight.endX - W * 0.5) * p;
        var groundY = (H - 20) + (ty - (H - 20)) * p;
        var arcLift = Math.sin(p * Math.PI) * 58;
        var py = groundY - arcLift;
        var sc = 1 - p * 0.52;

        c.fillStyle = 'rgba(0,0,0,0.42)';
        c.beginPath(); c.ellipse(px, groundY + 4, 16 * sc, 5 * sc, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#64748B'; c.strokeStyle = '#F1F5F9'; c.lineWidth = 1.6;
        c.beginPath(); c.ellipse(px, py, 17 * sc, 8 * sc, p * 4, 0, Math.PI * 2); c.fill(); c.stroke();

        if (chaveFlight.p >= 1 && !chaveFlight.impacted) {
          chaveFlight.impacted = true;
          var res = chaveFlight.serverData;
          FuranchoAudio.ironClank(res.result);
          if (res.result === 'pleno' || res.result === 'roce') {
            chaveBladeSpin = res.result === 'pleno' ? 16 : 7;
            var nSparks = res.result === 'pleno' ? 24 : 10;
            for (var sp = 0; sp < nSparks; sp++) {
              var a = Math.random() * Math.PI * 2;
              var v = 1.5 + Math.random() * 4.2;
              chaveSparkParticles.push({ x: tx, y: ty - 10, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.5, life: 1 });
            }
          }
          chaveFlight.onImpact(res);
          setTimeout(function () { chaveFlight = null; }, 650);
        }
      }

      for (var j = chaveSparkParticles.length - 1; j >= 0; j--) {
        var pt = chaveSparkParticles[j];
        pt.x += pt.vx; pt.y += pt.vy; pt.vy += 0.18; pt.life -= 0.04;
        if (pt.life <= 0) { chaveSparkParticles.splice(j, 1); continue; }
        c.fillStyle = 'rgba(253, 186, 116, ' + pt.life.toFixed(2) + ')';
        c.beginPath(); c.arc(pt.x, pt.y, 2.2, 0, Math.PI * 2); c.fill();
      }

      cv._currentTiming = Math.round(currentTiming);
      chaveRaf = requestAnimationFrame(renderChave3DLoop);
    }

    window.openChaveVirtualModal = async function () {
      B84Nav.closeAll('chave-virtual-modal');
      ensureChave3DCanvas();
      document.getElementById('chave-virtual-modal').style.display = 'flex';
      B84Nav.syncDockActive();
      document.getElementById('chave-msg').textContent = '';
      var btn = document.getElementById('chave-throw-btn');
      btn.style.display = 'none';
      btn.textContent = '🎯 ¡LANZAR PELLOTE!';
      document.getElementById('chave-status-text').textContent = 'Preparando terreiro...';
      chaveStateReady = false;
      chaveFlight = null;
      if (!chaveRaf) chaveRaf = requestAnimationFrame(renderChave3DLoop);

      try {
        var r = await fetch('/api/minigames/chave/status', { headers: { 'wallet-address': activeWallet() } });
        var d = await r.json();
        if (!isModalVisible('chave-virtual-modal')) return;
        if (!r.ok || d.error) {
          document.getElementById('chave-status-text').textContent = d.error || 'Error al conectar.';
        } else if (!d.enabled) {
          document.getElementById('chave-status-text').textContent = 'Xogo pechado temporalmente.';
        } else if (d.playsLeft <= 0) {
          document.getElementById('chave-status-text').textContent = 'Tiradas esgotadas hoxe. Volve mañá ao terreiro.';
        } else {
          document.getElementById('chave-status-text').textContent = 'Coste: ' + d.entryCost + ' $CORCHO · Quédanche ' + d.playsLeft + ' pellotes hoxe.';
          btn.style.display = 'block';
          chaveStateReady = true;
        }
      } catch (_) {
        document.getElementById('chave-status-text').textContent = 'Erro de rede.';
      }
    };

    window.throwChave = async function () {
      if (!chaveStateReady || chaveFlight) return;
      chaveStateReady = false;
      var cv = document.getElementById('b84-chave-canvas');
      var timing = cv && typeof cv._currentTiming === 'number' ? cv._currentTiming : 50;
      document.getElementById('chave-throw-btn').style.display = 'none';
      var msgEl = document.getElementById('chave-msg');
      msgEl.textContent = 'Voando o pellote...';
      msgEl.style.color = '#F3D58D';

      try {
        var r = await fetch('/api/minigames/chave/throw', {
          method: 'POST',
          headers: { 'wallet-address': activeWallet(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ timing: timing, lateral: 0 })
        });
        var data = await r.json();
        if (data.error) throw new Error(data.error);

        var W = cv ? cv.width : 292;
        var endX = W * 0.18 + (timing / 100) * (W * 0.64);
        chaveFlight = {
          p: 0,
          endX: endX,
          serverData: data,
          impacted: false,
          onImpact: function (res) {
            if (!isModalVisible('chave-virtual-modal')) return;
            if (res.result === 'pleno') {
              msgEl.textContent = '💥 ¡¡CHAVE PLENA!! +' + res.prize + ' $CORCHO';
              msgEl.style.color = '#4ADE80';
            } else if (res.result === 'roce') {
              msgEl.textContent = '✨ ¡Ferro rozado! +' + res.prize + ' $CORCHO';
              msgEl.style.color = '#FACC15';
            } else {
              msgEl.textContent = '💨 Petou na terra... sen premio.';
              msgEl.style.color = '#CBD5E1';
            }
            if (res.prize > 0) refreshBalanceQuietly();
            // Solo recargar estado si el jugador SIGUE dentro del modal de A Chave
            _gameTimers.chaveReopen = setTimeout(function () {
              if (isModalVisible('chave-virtual-modal')) window.openChaveVirtualModal();
            }, 2300);
          }
        };
      } catch (e) {
        msgEl.textContent = e.message;
        msgEl.style.color = '#F87171';
        document.getElementById('chave-throw-btn').style.display = 'block';
        chaveStateReady = true;
      }
    };

    // ── RECREATIVA DE BAR "A RÍA '85" ──
    window.spinTraga = async function () {
      var btn = document.getElementById('traga-spin-btn');
      var msg = document.getElementById('traga-msg');
      btn.style.display = 'none';
      msg.textContent = '🕹️ Xirando tambores...';
      msg.style.color = '#FDE047';
      FuranchoAudio.woodTap();

      var slots = [document.getElementById('slot-1'), document.getElementById('slot-2'), document.getElementById('slot-3')];
      var symbols = ['🍷', '🥟', '🐙', '🐚', '🌿'];
      var locked = [false, false, false];

      slots.forEach(function (s) {
        s.style.background = 'linear-gradient(180deg,#cfc2aa 0%,#fffdf8 48%,#bfb094 100%)';
        s.style.borderRadius = '8px';
        s.style.boxShadow = 'inset 0 4px 8px rgba(0,0,0,0.35)';
      });

      clearAllGameTimers();
      _gameTimers.tragaSpin = setInterval(function () {
        if (!isModalVisible('traga-modal')) { clearAllGameTimers(); return; }
        for (var i = 0; i < 3; i++) {
          if (!locked[i]) {
            slots[i].textContent = symbols[Math.floor(Math.random() * symbols.length)];
            slots[i].style.transform = 'translateY(' + ((Math.random() - 0.5) * 5).toFixed(1) + 'px)';
          }
        }
        FuranchoAudio.reelTick(280 + Math.random() * 90);
      }, 85);

      try {
        var res = await fetch('/api/minigames/traga/spin', { method: 'POST', headers: { 'wallet-address': activeWallet() } });
        var data = await res.json();
        if (data.error) throw new Error(data.error);

        [850, 1450, 2100].forEach(function (delay, idx) {
          setTimeout(function () {
            if (!isModalVisible('traga-modal')) return;
            locked[idx] = true;
            slots[idx].textContent = data.result[idx];
            slots[idx].style.transform = 'scale(1.14)';
            setTimeout(function () { slots[idx].style.transform = 'none'; }, 140);
            FuranchoAudio.reelTick(180 - idx * 25);
            vibrate(18);

            if (idx === 2) {
              if (_gameTimers.tragaSpin) { clearInterval(_gameTimers.tragaSpin); _gameTimers.tragaSpin = null; }
              if (data.prize > 0) {
                FuranchoAudio.coinDrop();
                msg.textContent = '🪙 ¡PREMIO NA TASCA! +' + data.prize + ' $CORCHO';
                msg.style.color = '#4ADE80';
                refreshBalanceQuietly();
              } else {
                msg.textContent = 'Sen liña desta vez, neno.';
                msg.style.color = '#EADBC0';
              }
              _gameTimers.tragaReopen = setTimeout(function () {
                if (isModalVisible('traga-modal')) window.openTragaModal();
              }, 2400);
            }
          }, delay);
        });
      } catch (e) {
        clearAllGameTimers();
        slots.forEach(function (s) { s.style.transform = 'none'; });
        msg.textContent = e.message;
        msg.style.color = '#F87171';
        btn.style.display = 'block';
      }
    };

    // ── O RASCA DE CORCHO E OURO REAL ──
    window.buyRasca = async function () {
      var buyBtn = document.getElementById('rasca-buy-btn');
      var msg = document.getElementById('rasca-msg');
      buyBtn.style.display = 'none';
      msg.textContent = 'Cortando boleto na barra...';
      msg.style.color = '#5E3418';

      try {
        var res = await fetch('/api/minigames/rasca/play', { method: 'POST', headers: { 'wallet-address': activeWallet() } });
        var data = await res.json();
        if (data.error) throw new Error(data.error);

        var area = document.getElementById('rasca-play-area');
        area.style.display = 'block';
        area.style.border = '2px dashed #8B0A1A';
        area.style.background = '#FFFDF7';

        var syms = Array.isArray(data.symbols) ? data.symbols.join('  ') : (data.result === 'gold' ? '👑 👑 👑' : data.result === 'silver' ? '🍷 🍷 🍷' : data.result === 'bronze' ? '🐙 🐙 🐙' : '🍷 🌿 🐚');
        document.getElementById('rasca-result').textContent = syms;

        var cv = document.getElementById('rasca-canvas');
        cv.style.display = 'block';
        var c = cv.getContext('2d');
        c.globalCompositeOperation = 'source-over';

        var grad = c.createLinearGradient(0, 0, cv.width, cv.height);
        grad.addColorStop(0, '#C89B3C');
        grad.addColorStop(0.5, '#E6C575');
        grad.addColorStop(1, '#A67824');
        c.fillStyle = grad;
        c.fillRect(0, 0, cv.width, cv.height);
        for (var d = 0; d < 180; d++) {
          c.fillStyle = d % 2 === 0 ? 'rgba(92,52,20,0.22)' : 'rgba(255,248,220,0.25)';
          c.fillRect(Math.random() * cv.width, Math.random() * cv.height, 3, 2);
        }
        c.strokeStyle = '#6E0B19'; c.lineWidth = 2;
        c.strokeRect(6, 6, cv.width - 12, cv.height - 12);
        c.fillStyle = '#4A040D';
        c.font = 'bold 14px serif';
        c.textAlign = 'center';
        c.fillText('★ RASCA CO DEDO · 1984 ★', cv.width / 2, cv.height / 2 + 5);

        msg.innerHTML = 'Rasca co dedo para descubrir os 3 selos!';

        var cols = 16, rows = 8;
        var grid = new Uint8Array(cols * rows);
        var clearedCount = 0;
        var revealed = false;
        var pointerDown = false;

        function finishReveal() {
          if (revealed) return;
          revealed = true;
          cv.style.display = 'none';
          if (data.prize > 0) {
            FuranchoAudio.coinDrop();
            msg.textContent = '🎉 ¡PREMIO! Gañas ' + data.prize + ' $CORCHO';
            msg.style.color = '#15803d';
            refreshBalanceQuietly();
          } else {
            FuranchoAudio.woodTap();
            msg.textContent = 'Sen premio neste boleto, rapaz.';
            msg.style.color = '#5E3418';
          }
          buyBtn.textContent = '🎟️ MERCAR OUTRO BOLETO';
          buyBtn.style.display = 'block';
          buyBtn.onclick = function () { window.openRascaModal(); };
        }

        function scratchAt(clientX, clientY) {
          if (revealed) return;
          var rect = cv.getBoundingClientRect();
          var x = (clientX - rect.left) * (cv.width / rect.width);
          var y = (clientY - rect.top) * (cv.height / rect.height);
          c.globalCompositeOperation = 'destination-out';
          c.beginPath(); c.arc(x, y, 21, 0, Math.PI * 2); c.fill();

          var gx = Math.floor((x / cv.width) * cols);
          var gy = Math.floor((y / cv.height) * rows);
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              var nx = gx + dx, ny = gy + dy;
              if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) {
                var idx = ny * cols + nx;
                if (!grid[idx]) { grid[idx] = 1; clearedCount++; }
              }
            }
          }
          if (clearedCount === 8) vibrate(10);
          if (clearedCount >= cols * rows * 0.42) finishReveal();
        }

        cv.onclick = null;
        cv.onpointerdown = function (e) { pointerDown = true; cv.setPointerCapture(e.pointerId); scratchAt(e.clientX, e.clientY); };
        cv.onpointermove = function (e) { if (pointerDown) scratchAt(e.clientX, e.clientY); };
        cv.onpointerup = function () { pointerDown = false; };
      } catch (e) {
        msg.textContent = e.message;
        msg.style.color = '#dc2626';
        buyBtn.style.display = 'block';
      }
    };

    // ── A QUEIMADA NA LAREIRA ──
    var queimadaCanvasRaf = null, queimadaLiveScore = 0, queimadaBurned = false;

    function ensureQueimadaCanvas() {
      var oldSvg = document.getElementById('queimada-cauldron-svg');
      if (!oldSvg || document.getElementById('b84-queimada-canvas')) return;
      oldSvg.style.display = 'none';
      var cv = document.createElement('canvas');
      cv.id = 'b84-queimada-canvas';
      cv.width = 220; cv.height = 180;
      cv.style.cssText = 'width:220px; height:180px; display:block;';
      oldSvg.parentNode.appendChild(cv);
    }

    function startQueimadaFireLoop() {
      if (queimadaCanvasRaf) return;
      var t = 0;
      function drawFire() {
        if (!isModalVisible('queimada-modal')) { queimadaCanvasRaf = null; return; }
        var cv = document.getElementById('b84-queimada-canvas');
        if (!cv) { queimadaCanvasRaf = null; return; }
        var c = cv.getContext('2d');
        var W = cv.width, H = cv.height;
        t += 0.05;
        c.clearRect(0, 0, W, H);

        var ember = c.createRadialGradient(110, 162, 6, 110, 162, 72);
        ember.addColorStop(0, 'rgba(239, 68, 68, 0.55)');
        ember.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = ember; c.fillRect(0, 120, W, 60);

        var intensity = Math.max(0.25, Math.min(1.35, queimadaLiveScore / 21));
        var nFlames = 14;
        for (var i = 0; i < nFlames; i++) {
          var fx = 58 + (i / (nFlames - 1)) * 104 + Math.sin(t * 2.4 + i) * 4;
          var fh = (22 + Math.sin(t * 3.8 + i * 1.9) * 14) * intensity * (queimadaBurned ? 1.5 : 1);
          var fg = c.createLinearGradient(fx, 102, fx, 102 - fh);
          if (queimadaBurned) {
            fg.addColorStop(0, 'rgba(239, 68, 68, 0.92)');
            fg.addColorStop(0.6, 'rgba(249, 115, 22, 0.65)');
            fg.addColorStop(1, 'rgba(0,0,0,0)');
          } else {
            fg.addColorStop(0, 'rgba(37, 99, 235, 0.88)');
            fg.addColorStop(0.55, 'rgba(96, 165, 250, 0.65)');
            fg.addColorStop(0.85, 'rgba(253, 224, 71, 0.35)');
            fg.addColorStop(1, 'rgba(255,255,255,0)');
          }
          c.fillStyle = fg;
          c.beginPath(); c.ellipse(fx, 98 - fh * 0.4, 9, fh * 0.65, 0, 0, Math.PI * 2); c.fill();
        }

        var potG = c.createLinearGradient(35, 92, 185, 160);
        potG.addColorStop(0, '#7C3A19');
        potG.addColorStop(0.45, '#9A4B22');
        potG.addColorStop(1, '#3E1B0A');
        c.fillStyle = potG;
        c.strokeStyle = '#240F05'; c.lineWidth = 2.5;
        c.beginPath();
        c.moveTo(36, 98); c.quadraticCurveTo(32, 154, 110, 156); c.quadraticCurveTo(188, 154, 184, 98);
        c.closePath(); c.fill(); c.stroke();

        c.fillStyle = queimadaBurned ? '#7F1D1D' : '#1E3A8A';
        c.beginPath(); c.ellipse(110, 98, 74, 13, 0, 0, Math.PI * 2); c.fill(); c.stroke();

        queimadaCanvasRaf = requestAnimationFrame(drawFire);
      }
      queimadaCanvasRaf = requestAnimationFrame(drawFire);
    }

    var origOpenQueimada = window.openQueimadaModal;
    window.openQueimadaModal = function () {
      B84Nav.closeAll('queimada-modal');
      queimadaLiveScore = 0;
      queimadaBurned = false;
      origOpenQueimada();
      ensureQueimadaCanvas();
      startQueimadaFireLoop();
      B84Nav.syncDockActive();
    };

    var origDrawQueimada = window.drawQueimadaIngredient;
    window.drawQueimadaIngredient = async function () {
      FuranchoAudio.fireWhoosh();
      await origDrawQueimada();
      var sc = parseInt(document.getElementById('queimada-score')?.textContent || '0', 10) || 0;
      queimadaLiveScore = sc;
      queimadaBurned = sc > 21;
    };

    // ── TRIVIAL DA PARROQUIA '84 ──
    var trivQs = [], trivIdx = 0, trivAnswers = [], trivSec = 12;

    window.openTrivialModal = async function () {
      B84Nav.closeAll('trivial-modal');
      document.getElementById('trivial-modal').style.display = 'flex';
      B84Nav.syncDockActive();
      document.getElementById('trivial-msg').textContent = '';
      document.getElementById('trivial-start-btn').style.display = 'none';
      document.getElementById('trivial-quiz-area').style.display = 'none';
      document.getElementById('trivial-status-text').textContent = 'Sintonizando Radio Parroquia...';

      try {
        var r = await fetch('/api/minigames/trivial/status', { headers: { 'wallet-address': activeWallet() } });
        var d = await r.json();
        if (!isModalVisible('trivial-modal')) return;
        if (!r.ok || d.error) {
          document.getElementById('trivial-status-text').textContent = d.error || 'Erro ao conectar.';
        } else if (!d.enabled) {
          document.getElementById('trivial-status-text').textContent = 'Concurso pechado temporalmente.';
        } else if (d.playsLeft <= 0) {
          document.getElementById('trivial-status-text').textContent = 'Xa participaches hoxe. Mañá novas preguntas!';
        } else {
          document.getElementById('trivial-status-text').textContent = 'Coste: ' + d.entryCost + ' $CORCHO · Acerta as 3 preguntas!';
          var btn = document.getElementById('trivial-start-btn');
          btn.style.display = 'block';
          btn.textContent = d.resumable ? '📻 CONTINUAR CONCURSO' : '📻 COMEZAR RETO';
          trivQs = d.questions || [];
        }
      } catch (_) {
        document.getElementById('trivial-status-text').textContent = 'Erro de rede.';
      }
    };

    window.startTrivial = async function () {
      var btn = document.getElementById('trivial-start-btn');
      btn.style.display = 'none';
      try {
        var r = await fetch('/api/minigames/trivial/start', {
          method: 'POST',
          headers: { 'wallet-address': activeWallet(), 'Content-Type': 'application/json' }
        });
        var d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'Non se puido iniciar');
        trivQs = d.questions || trivQs;
        trivIdx = 0;
        trivAnswers = [];
        refreshBalanceQuietly();
        document.getElementById('trivial-quiz-area').style.display = 'block';
        renderTrivialStep();
      } catch (e) {
        document.getElementById('trivial-msg').textContent = e.message;
        document.getElementById('trivial-msg').style.color = '#dc2626';
        btn.style.display = 'block';
      }
    };

    function renderTrivialStep() {
      if (!isModalVisible('trivial-modal')) return;
      if (trivIdx >= 3) {
        submitTrivialToServer(true, '');
        return;
      }
      var q = trivQs[trivIdx];
      document.getElementById('trivial-progress').textContent = 'Pregunta ' + (trivIdx + 1) + ' / 3';
      document.getElementById('trivial-q').textContent = q.q;
      var box = document.getElementById('trivial-options');
      box.innerHTML = '';
      q.o.forEach(function (optText, idx) {
        var b = document.createElement('button');
        b.textContent = optText;
        b.style.cssText = 'padding:12px; background:#FFFDF8; border:1.5px solid #C89B3C; border-radius:10px; font-size:13.5px; text-align:left; cursor:pointer; font-weight:700; color:#23140B; transition:all 0.18s;';
        b.onclick = function () { onTrivialPick(idx, b); };
        box.appendChild(b);
      });

      trivSec = 12;
      document.getElementById('trivial-timer').textContent = '⏱️ ' + trivSec + 's';
      if (_gameTimers.trivialTick) clearInterval(_gameTimers.trivialTick);
      _gameTimers.trivialTick = setInterval(function () {
        if (!isModalVisible('trivial-modal')) { clearAllGameTimers(); return; }
        trivSec--;
        document.getElementById('trivial-timer').textContent = '⏱️ ' + trivSec + 's';
        if (trivSec <= 0) {
          clearAllGameTimers();
          trivAnswers.push(-1);
          submitTrivialToServer(false, 'Acabouse o tempo!');
        }
      }, 1000);
    }

    async function onTrivialPick(selectedIdx, btnNode) {
      clearAllGameTimers();
      var allBtns = document.getElementById('trivial-options').querySelectorAll('button');
      allBtns.forEach(function (b) { b.disabled = true; });
      trivAnswers.push(selectedIdx);

      try {
        var r = await fetch('/api/minigames/trivial/check', {
          method: 'POST',
          headers: { 'wallet-address': activeWallet(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionIndex: trivIdx, selectedIdx: selectedIdx })
        });
        var check = await r.json();
        if (!isModalVisible('trivial-modal')) return;
        if (check.correct) {
          FuranchoAudio.clinkCunca();
          btnNode.style.background = '#dcfce7';
          btnNode.style.borderColor = '#16a34a';
          setTimeout(function () { trivIdx++; renderTrivialStep(); }, 850);
        } else {
          FuranchoAudio.woodTap();
          btnNode.style.background = '#fee2e2';
          btnNode.style.borderColor = '#dc2626';
          if (allBtns[check.correctIndex]) {
            allBtns[check.correctIndex].style.background = '#dcfce7';
            allBtns[check.correctIndex].style.borderColor = '#16a34a';
          }
          setTimeout(function () { submitTrivialToServer(false, 'Resposta incorrecta'); }, 1300);
        }
      } catch (_) {
        submitTrivialToServer(false, 'Erro de conexión');
      }
    }

    async function submitTrivialToServer(allRight, reason) {
      clearAllGameTimers();
      document.getElementById('trivial-quiz-area').style.display = 'none';
      var msg = document.getElementById('trivial-msg');
      msg.textContent = 'Selando papeleta...';
      try {
        var r = await fetch('/api/minigames/trivial/submit', {
          method: 'POST',
          headers: { 'wallet-address': activeWallet(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers: trivAnswers })
        });
        var d = await r.json();
        if (d.won) {
          FuranchoAudio.coinDrop();
          msg.textContent = '🏆 ¡PLENO PARROQUIAL! +' + d.prize + ' $CORCHO';
          msg.style.color = '#15803d';
          refreshBalanceQuietly();
        } else {
          msg.textContent = '📻 ' + (reason || 'Mala sorte hoxe') + '. Proba mañá!';
          msg.style.color = '#991b1b';
        }
      } catch (e) {
        msg.textContent = e.message;
      }
    }

    var origSpinRuleta = window.spinRuleta;
    if (typeof origSpinRuleta === 'function') {
      window.spinRuleta = async function () {
        var delays = [120, 240, 380, 540, 720, 930, 1180, 1470, 1810, 2220, 2700, 3260, 3800];
        delays.forEach(function (ms) {
          setTimeout(function () {
            if (isModalVisible('ruleta-modal')) {
              FuranchoAudio.reelTick(420);
              vibrate(8);
            }
          }, ms);
        });
        return origSpinRuleta();
      };
    }
  }

  function boot() {
    mountBaixo84Stage();
    upgradeAllMinigames84();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 60); });
  } else {
    setTimeout(boot, 60);
  }
})();

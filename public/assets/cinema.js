/* ============================================================
   FURANCHO SESSIONS · DRIVER DE LA CAPA "CINEMA"
   Acompaña a cinema.css. Es opcional por diseño: si este script
   no carga o falla, la app queda con la profundidad estática del
   CSS y nada se rompe.

   Qué hace:
     · Inyecta el telón de fondo cinematográfico en <body>.
     · Inclina `.cin-plate` con el puntero (escritorio) o el
       giroscopio (móvil), con interpolación suave.
     · Respira sola cuando no hay input (`cin-idle`).
     · Se apaga con "reducir movimiento" y fuera de pantalla.
     · Guarda de seguridad: mientras hay una capa fixed abierta
       (modal, escáner QR), quita el transform del plano para no
       capturar elementos position:fixed.
   ============================================================ */
(function () {
  'use strict';

  var TILT = 7;          // grados máximos de inclinación
  var SHIFT = 1;         // desplazamiento normalizado máximo del telón
  var IDLE_AFTER = 2600; // ms sin input antes de volver a respirar sola

  var reduced = false;
  try {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {}

  // ── Telón de fondo ────────────────────────────────────────
  function mountBackdrop() {
    if (document.querySelector('.cin-backdrop')) return;
    var b = document.createElement('div');
    b.className = 'cin-backdrop';
    b.setAttribute('aria-hidden', 'true');
    b.innerHTML =
      '<div class="cin-light">' +
        '<div class="cin-glow"></div>' +
        '<div class="cin-rays"></div>' +
        '<div class="cin-motes"></div>' +
      '</div>' +
      '<div class="cin-tint"></div>' +
      '<div class="cin-spill"></div>' +
      '<div class="cin-spill-foot"></div>' +
      '<div class="cin-vignette"></div>' +
      '<div class="cin-grain"></div>';
    document.body.appendChild(b);
  }

  // ── Lugares ───────────────────────────────────────────────
  // La app es un sitio con salas (o Furancho, o Banco, o Museo…).
  // Al pulsar un portal se cambia la luz ambiente de la sala.
  var placeTimer = null;

  function setPlace(name) {
    if (!name) return;
    var root = document.documentElement;
    if (root.getAttribute('data-cin-place') === name) return;
    root.setAttribute('data-cin-place', name);

    var b = document.querySelector('.cin-backdrop');
    if (!b || reduced) return;

    // Fogonazo de llegada: se reinicia la animación cada vez.
    b.classList.remove('cin-arrive');
    void b.offsetWidth;
    b.classList.add('cin-arrive');
    clearTimeout(placeTimer);
    placeTimer = setTimeout(function () { b.classList.remove('cin-arrive'); }, 1200);
  }

  // Delegación: cualquier elemento con data-cin-place es un portal.
  // No toca ninguna función existente de las apps.
  var placeIsRoom = false; // la sala actual se abrió como modal

  function onPortalClick(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-cin-place]') : null;
    if (!el) return;
    setPlace(el.getAttribute('data-cin-place'));

    // En el cliente las salas son modales; en el admin son páginas.
    // Si el portal abrió un modal, al cerrarlo volvemos a casa.
    setTimeout(function () {
      try { placeIsRoom = overlayOpen(); } catch (_) { placeIsRoom = false; }
    }, 320);
  }

  function homeIfLeftRoom() {
    if (!placeIsRoom) return;
    placeIsRoom = false;
    setPlace(document.body.getAttribute('data-cin-place-default') || 'furancho');
  }

  // ── Estado del parallax ───────────────────────────────────
  var targetX = 0, targetY = 0;   // objetivo normalizado -1..1
  var currentX = 0, currentY = 0; // valor interpolado
  var stages = [];
  var visible = [];
  var lastInput = 0;
  var rafId = null;
  var halted = false;

  function collectStages() {
    stages = [].slice.call(document.querySelectorAll('.cin-stage'));
    visible = stages.slice();

    if (!('IntersectionObserver' in window) || !stages.length) return;

    // Solo animamos los escenarios que se ven: ahorra batería en
    // pantallas largas donde el hero queda fuera de vista.
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var i = visible.indexOf(e.target);
        if (e.isIntersecting && i === -1) visible.push(e.target);
        if (!e.isIntersecting && i !== -1) visible.splice(i, 1);
      });
    }, { rootMargin: '80px' });

    stages.forEach(function (s) { io.observe(s); });
  }

  function setIdle(on) {
    stages.forEach(function (s) { s.classList.toggle('cin-idle', on); });
  }

  function tick() {
    rafId = null;

    // Interpolación: el plano persigue al objetivo, nunca salta.
    currentX += (targetX - currentX) * 0.085;
    currentY += (targetY - currentY) * 0.085;

    var rootStyle = document.documentElement.style;
    rootStyle.setProperty('--cin-mx', (currentX * SHIFT).toFixed(4));
    rootStyle.setProperty('--cin-my', (currentY * SHIFT).toFixed(4));

    if (!halted) {
      var ry = (currentX * TILT).toFixed(3) + 'deg';
      var rx = (-currentY * TILT).toFixed(3) + 'deg';
      visible.forEach(function (s) {
        s.style.setProperty('--cin-ry', ry);
        s.style.setProperty('--cin-rx', rx);
      });
    }

    var settled = Math.abs(targetX - currentX) < 0.0015 &&
                  Math.abs(targetY - currentY) < 0.0015;

    if (!settled) {
      schedule();
    } else if (Date.now() - lastInput > IDLE_AFTER) {
      // En reposo devolvemos el control a la animación CSS.
      visible.forEach(function (s) {
        s.style.removeProperty('--cin-ry');
        s.style.removeProperty('--cin-rx');
      });
      setIdle(true);
    }
  }

  function schedule() {
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  function aim(x, y) {
    targetX = Math.max(-1, Math.min(1, x));
    targetY = Math.max(-1, Math.min(1, y));
    lastInput = Date.now();
    setIdle(false);
    schedule();
  }

  // ── Puntero (escritorio) ──────────────────────────────────
  function onPointer(e) {
    if (e.pointerType === 'touch') return; // el dedo ya tiene el giroscopio
    var w = window.innerWidth || 1;
    var h = window.innerHeight || 1;
    aim((e.clientX / w) * 2 - 1, (e.clientY / h) * 2 - 1);
  }

  function onLeave() {
    aim(0, 0);
    lastInput = 0; // deja que vuelva a respirar sola enseguida
  }

  // ── Giroscopio (móvil) ────────────────────────────────────
  function onOrient(e) {
    if (e.gamma == null && e.beta == null) return;
    // gamma: inclinación izquierda/derecha · beta: adelante/atrás.
    // Centramos beta en 45° (cómo se sostiene el móvil al mirarlo).
    aim((e.gamma || 0) / 32, ((e.beta || 0) - 45) / 32);
  }

  function enableGyro() {
    if (!('DeviceOrientationEvent' in window)) return;

    var DOE = window.DeviceOrientationEvent;

    // iOS 13+ exige permiso y solo lo concede desde un gesto real.
    if (typeof DOE.requestPermission === 'function') {
      var ask = function () {
        DOE.requestPermission().then(function (state) {
          if (state === 'granted') window.addEventListener('deviceorientation', onOrient, { passive: true });
        }).catch(function () { /* denegado: nos quedamos con la respiración CSS */ });
        window.removeEventListener('touchend', ask);
        window.removeEventListener('click', ask);
      };
      window.addEventListener('touchend', ask, { once: true, passive: true });
      window.addEventListener('click', ask, { once: true });
      return;
    }

    window.addEventListener('deviceorientation', onOrient, { passive: true });
  }

  // ── Guarda de seguridad para modales fixed ────────────────
  // Un transform en un ancestro convierte al elemento en contenedor
  // de sus descendientes position:fixed. Los escenarios no envuelven
  // modales, pero si alguna vez se mueve el marcado, esto lo cubre:
  // con una capa fixed visible el plano se queda plano.
  function overlayOpen() {
    var nodes = document.querySelectorAll('[style*="fixed"], .modal, .modal-overlay, [role="dialog"]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.classList && n.classList.contains('cin-backdrop')) continue;
      var cs = window.getComputedStyle(n);
      if (cs.position !== 'fixed') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      if (n.offsetWidth < 120 || n.offsetHeight < 120) continue; // banners y chips, no
      return true;
    }
    return false;
  }

  function syncHalt() {
    var open = false;
    try { open = overlayOpen(); } catch (_) {}
    if (open === halted) return;
    halted = open;
    document.documentElement.classList.toggle('cin-halt', halted);
    if (!halted) { homeIfLeftRoom(); schedule(); }
  }

  // ── Arranque ──────────────────────────────────────────────
  function start() {
    mountBackdrop();
    collectStages();

    // Los portales funcionan incluso con "reducir movimiento": el cambio
    // de luz de sala es identidad del sitio, no decoración animada.
    document.addEventListener('click', onPortalClick, true);
    if (!document.documentElement.getAttribute('data-cin-place')) {
      setPlace(document.body.getAttribute('data-cin-place-default') || 'furancho');
    }

    // Comprobación barata y espaciada: no observamos todo el DOM, que en
    // estas páginas cambia constantemente. Cubre la guarda de los modales
    // fixed y el regreso a casa al cerrar una sala.
    setInterval(syncHalt, 450);

    if (reduced || !stages.length) return;

    setIdle(true);

    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('pointerdown', onPointer, { passive: true });
    document.addEventListener('pointerleave', onLeave, { passive: true });
    enableGyro();

    // Reexploramos por si una pantalla añade escenarios más tarde.
    window.addEventListener('load', collectStages);
  }

  // API mínima por si alguna vista necesita silenciar el efecto.
  window.cinema = {
    pause: function () {
      halted = true;
      document.documentElement.classList.add('cin-halt');
    },
    resume: function () {
      halted = false;
      document.documentElement.classList.remove('cin-halt');
      schedule();
    },
    place: setPlace,
    refresh: collectStages
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

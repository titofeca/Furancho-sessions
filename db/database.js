// Usa el SQLite nativo de Node.js (v22+) — sin dependencias externas ni compilación
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'furancho.db');

// Asegurar que el directorio de la BD existe (necesario para volúmenes de Railway)
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

console.log(`[DB] Base de datos en: ${DB_PATH}`);
const db = new DatabaseSync(DB_PATH);

// Activar WAL mode, foreign keys y busy_timeout para tolerar bloqueos en rolling deploy
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

try { db.exec(`CREATE TABLE IF NOT EXISTS prize_presets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`); } catch (_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS raffle_participants (raffle_id INTEGER NOT NULL, wallet_address TEXT NOT NULL, PRIMARY KEY (raffle_id, wallet_address))`); } catch (_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS scheduled_raffles (id INTEGER PRIMARY KEY AUTOINCREMENT, event_date TEXT NOT NULL, scheduled_time TEXT NOT NULL, prize TEXT NOT NULL, status TEXT DEFAULT 'pending', raffle_id INTEGER, target_level INTEGER, created_at TEXT DEFAULT (datetime('now')))`); } catch (_) {}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      delivered_at TEXT,
      delivered_by TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_redemptions_wallet ON redemptions(wallet_address)`);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      claimed_week TEXT NOT NULL,
      claimed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(wallet_address, claimed_week)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_weekly_claims_week ON weekly_claims(claimed_week)`);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_raffles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claimed_week TEXT NOT NULL UNIQUE,
      prize TEXT NOT NULL DEFAULT 'Botella de Viño de la Casa',
      rules TEXT DEFAULT 'Trinca tu participación una vez por semana antes de que empiecen los eventos. ¡Se sorteará un regalo de la hostia!',
      winners_count INTEGER DEFAULT 1,
      winner_wallet TEXT,
      drawn_at TEXT,
      status TEXT DEFAULT 'active'
    )
  `);
} catch (_) {}
try {
  db.exec(`ALTER TABLE weekly_raffles ADD COLUMN winners_count INTEGER DEFAULT 1`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE weekly_raffles ADD COLUMN rules TEXT DEFAULT 'Trinca tu participación una vez por semana antes de que empiecen los eventos. ¡Se sorteará un regalo de la hostia!'`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE weekly_raffles ADD COLUMN verification_code TEXT`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE weekly_raffles ADD COLUMN collected_at TEXT`);
} catch (_) {}
// Premio dado por perdido (no recogido a tiempo): queda registrado pero no como entregado
try {
  db.exec(`ALTER TABLE weekly_raffles ADD COLUMN forfeited_at TEXT`);
} catch (_) {}
// Confirmación del ganador: tras el sorteo del miércoles 21:00 debe confirmar antes de las 23:00
try {
  db.exec(`ALTER TABLE weekly_raffles ADD COLUMN confirm_deadline TEXT`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE weekly_raffles ADD COLUMN confirmed_at TEXT`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE weekly_raffles ADD COLUMN collected_wallets TEXT DEFAULT NULL`);
} catch (_) {}
// Limpiar reservas VIP huérfanas (apuntan a eventos que ya no existen)
try {
  db.exec(`DELETE FROM vip_reservations WHERE event_id NOT IN (SELECT id FROM events)`);
} catch (_) {}
// Tapas por evento
try {
  db.exec(`CREATE TABLE IF NOT EXISTS tapas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    emoji TEXT DEFAULT '🍽️',
    allergens TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (event_id) REFERENCES events(id)
  )`);
} catch (_) {}
try { db.exec(`ALTER TABLE tapas ADD COLUMN allergens TEXT DEFAULT ''`); } catch (_) {}

// =====================
// CREAR TABLAS
// =====================
db.exec(`
  CREATE TABLE IF NOT EXISTS mints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    wallet_address TEXT NOT NULL,
    level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 4),
    level_name TEXT NOT NULL,
    crossmint_action_id TEXT,
    status TEXT DEFAULT 'pending',
    event_date TEXT DEFAULT (date('now')),
    minted_at TEXT DEFAULT (datetime('now')),
    ip_address TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    level_filter TEXT DEFAULT 'all',
    recipient_count INTEGER DEFAULT 0,
    sent_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS raffles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prize TEXT NOT NULL,
    winner_wallet TEXT,
    verification_code TEXT,
    target_level INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mints_level ON mints(level);
  CREATE INDEX IF NOT EXISTS idx_mints_wallet ON mints(wallet_address);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mints_wallet_level ON mints(wallet_address, level);

  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    email TEXT,
    ip_address TEXT,
    visited_at TEXT DEFAULT (datetime('now')),
    event_date TEXT DEFAULT (date('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_visits_wallet ON visits(wallet_address);

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    entry_time TEXT DEFAULT (datetime('now')),
    exit_time TEXT,
    duration_minutes INTEGER,
    counted_as_visit INTEGER DEFAULT 0,
    exit_points INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_wallet ON sessions(wallet_address);

  CREATE TABLE IF NOT EXISTS points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    points INTEGER NOT NULL,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_points_wallet ON points(wallet_address);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_date TEXT NOT NULL UNIQUE,
    title TEXT DEFAULT 'Furancho Sessions',
    description TEXT,
    active INTEGER DEFAULT 1,
    vip_max INTEGER DEFAULT 15
  );

  CREATE TABLE IF NOT EXISTS rsvps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    wallet_address TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(event_id, wallet_address)
  );

  CREATE TABLE IF NOT EXISTS vip_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    wallet_address TEXT NOT NULL,
    phone TEXT NOT NULL,
    group_size INTEGER NOT NULL CHECK(group_size >= 4 AND group_size <= 15),
    status TEXT DEFAULT 'pending',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(event_id, wallet_address)
  );

  CREATE TABLE IF NOT EXISTS message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    wallet_address TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(message_id, wallet_address)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    channels TEXT DEFAULT 'general',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS push_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    target TEXT NOT NULL,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    total_count INTEGER DEFAULT 0,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS partner_establishments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    maps_url TEXT,
    story TEXT,
    visible INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Pre-poblar locales colaboradores iniciales si la tabla está vacía
try {
  const count = db.prepare(`SELECT COUNT(*) as c FROM partner_establishments`).get().c;
  if (count === 0) {
    const stmt = db.prepare(`INSERT INTO partner_establishments (name, maps_url, story, visible) VALUES (?, ?, ?, 0)`);
    stmt.run("Taberna O Pazo", "https://www.google.com/maps/search/?api=1&query=Taberna+O+Pazo+A+Coru%C3%B1a", "Una taberna de las de siempre en la zona vieja, donde el olor a cocina tradicional y el crujido de la madera te abrazan. Un rincón ideal para seguir la sobremesa.");
    stmt.run("Pulpería de Melide", "https://www.google.com/maps/search/?api=1&query=Pulper%C3%ADa+de+Melide+A+Coru%C3%B1a", "Míticos pulpeiros preparando el pulpo con el mimo que solo el respeto a la tradición gallega puede dar. Su caldero de cobre es parte de nuestra alma compartida.");
    stmt.run("La Bombilla", "https://www.google.com/maps/search/?api=1&query=La+Bombilla+A+Coru%C3%B1a", "La leyenda indiscutible de las tapas coruñesas. Sus pinchos icónicos encarnan el verdadero espíritu de compartir y disfrutar en las tabernas tradicionales.");
    stmt.run("O Tarabelo", "https://www.google.com/maps/search/?api=1&query=O+Tarabelo+A+Coru%C3%B1a", "Con sus cuncas de ribeiro y carácter marinero, O Tarabelo mantiene encendida la llama de nuestras raíces. Vecinos de sabor y tradición en la Ciudad Vieja.");
    stmt.run("O Cunqueiro", "https://www.google.com/maps/search/?api=1&query=O+Cunqueiro+A+Coru%C3%B1a", "Una parada obligada para saborear la gastronomía de siempre. Rinde homenaje al comer con autenticidad y alegría en la boa compañía de nuestro barrio.");
    console.log("[DB] Inicializados 5 locales colaboradores iniciales (ocultos).");
  } else {
    // Si la tabla ya existe, nos aseguramos de resetear la visibilidad de los iniciales a 0 para cumplir con la petición
    db.exec(`UPDATE partner_establishments SET visible = 0 WHERE name IN ('Taberna O Pazo', 'Pulpería de Melide', 'La Bombilla', 'O Tarabelo', 'O Cunqueiro')`);
  }
} catch (_) {}

// Migraciones de columnas y datos — DEBEN ir tras los CREATE TABLE para que
// también se apliquen en bases de datos nuevas (antes corrían antes y fallaban en silencio).
// Migraciones seguras
// Solo un evento hasta ahora → nadie puede tener nivel 2 legítimamente; bajar a nivel 1
try {
  const downgraded = db.prepare(`UPDATE mints SET level = 1 WHERE level = 2`).run();
  if (downgraded.changes > 0) console.log(`[DB] Migración: ${downgraded.changes} mints bajados de Nv2 → Nv1`);
} catch (_) {}

// Wallets con mint nivel 4 son de prueba → dejar solo 1 visita contada (la más antigua)
try {
  const fixed = db.prepare(`
    UPDATE sessions SET counted_as_visit = 0
    WHERE counted_as_visit = 1
      AND wallet_address IN (SELECT DISTINCT wallet_address FROM mints WHERE level = 4)
      AND id NOT IN (
        SELECT MIN(id) FROM sessions
        WHERE counted_as_visit = 1
          AND wallet_address IN (SELECT DISTINCT wallet_address FROM mints WHERE level = 4)
        GROUP BY wallet_address
      )
  `).run();
  if (fixed.changes > 0) console.log(`[DB] Migración: ${fixed.changes} visitas extra de wallets Nv4 puestas a 0`);
} catch (_) {}

try { db.exec(`ALTER TABLE events ADD COLUMN vip_max INTEGER DEFAULT 15`); } catch (_) {}
// Ventana horaria del evento (hora Madrid) — define cuándo un fichaje cuenta como elegible para sorteos en vivo
try { db.exec(`ALTER TABLE events ADD COLUMN start_time TEXT DEFAULT '19:00'`); } catch (_) {}
try { db.exec(`ALTER TABLE events ADD COLUMN end_time TEXT DEFAULT '23:59'`); } catch (_) {}
// Alias gracioso y anónimo de la reserva VIP (se genera al confirmar; hace de "nombre de la mesa")
try { db.exec(`ALTER TABLE vip_reservations ADD COLUMN alias TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN collected INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN collected_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN collected_by TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN status TEXT DEFAULT 'pending_acceptance'`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN acceptance_deadline TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN accepted_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN rejected_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN rejection_note TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN target_level INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN target_level INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN prize_details TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN prize_image TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN establishment TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN prize_details TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN prize_image TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN establishment TEXT`); } catch (_) {}
// type: 'night' | 'local' | 'chave'  — hide_name: mostrar "Sorpresa" en cliente hasta lanzar
try { db.exec(`ALTER TABLE raffles ADD COLUMN type TEXT DEFAULT 'night'`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN hide_name INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN type TEXT DEFAULT 'night'`); } catch (_) {}
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN hide_name INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN participant_level INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN participant_level INTEGER`); } catch (_) {}
// Número de serie del mint dentro de su nivel (1 = primero en alcanzar ese nivel)
try { db.exec(`ALTER TABLE mints ADD COLUMN mint_serial INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE mints ADD COLUMN mint_cost_matic REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE mints ADD COLUMN mint_source TEXT DEFAULT 'auto'`); } catch (_) {}
// Rellenar seriales históricos para mints existentes sin serial
try {
  [1,2,3,4].forEach(lvl => {
    const existing = db.prepare(`SELECT COUNT(*) as c FROM mints WHERE level = ? AND mint_serial IS NOT NULL AND status != 'failed'`).get(lvl).c;
    const rows = db.prepare(`SELECT id FROM mints WHERE level = ? AND mint_serial IS NULL AND status != 'failed' ORDER BY minted_at ASC`).all(lvl);
    rows.forEach((r, i) => db.prepare(`UPDATE mints SET mint_serial = ? WHERE id = ?`).run(existing + i + 1, r.id));
  });
} catch (_) {}
// NOTA: aquí existía una migración que re-marcaba retroactivamente como visita las sesiones
// con counted_as_visit=0 (fix histórico, ya aplicado en producción). Se eliminó porque con la
// regla actual (la visita solo cuenta si hay evento en la agenda y máximo 1 por semana) ese
// backfill desharía la política en cada arranque del servidor.

// Migraciones seguras
try { db.exec(`ALTER TABLE rsvps ADD COLUMN allergens TEXT`); } catch (_) {}
// Evento al que un mensaje adjunta el botón "¿te apetece?" (null = sin botón). Sustituye la detección por palabras clave.
try { db.exec(`ALTER TABLE messages ADD COLUMN rsvp_event_id INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN exit_points INTEGER DEFAULT 0`); } catch (_) {}
// Marca si la salida fue por auto-cierre de las 23:00 (1) o salida manual del cliente (0).
// Para sorteos: una salida manual saca del bombo; el auto-cierre NO (seguía dentro al acabar el evento).
try { db.exec(`ALTER TABLE sessions ADD COLUMN auto_closed INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE push_subscriptions ADD COLUMN channels TEXT DEFAULT 'general'`); } catch (_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS points (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_address TEXT NOT NULL, points INTEGER NOT NULL, reason TEXT, created_at TEXT DEFAULT (datetime('now')))`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_points_wallet ON points(wallet_address)`); } catch (_) {}

// Sesiones de prueba del 4 jun antes de las 19:30 no cuentan como visita real (19:30 CEST = 17:30 UTC)
try {
  db.exec(`
    UPDATE sessions SET counted_as_visit = 0
    WHERE date(entry_time) = '2026-06-04'
      AND time(entry_time) < '17:30:00'
      AND counted_as_visit = 1
  `);
} catch (_) {}

// =====================
// HELPERS
// =====================

function insertMint({ email, level, levelName, walletAddress, crossmintActionId, status, ipAddress }) {
  // Calcular el siguiente número de serie para este nivel
  const nextSerial = (db.prepare(`SELECT COUNT(*) as c FROM mints WHERE level = ? AND status != 'failed'`).get(level)?.c || 0) + 1;
  const stmt = db.prepare(`
    INSERT INTO mints (email, level, level_name, wallet_address, crossmint_action_id, status, ip_address, mint_serial)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(email || null, level, levelName, walletAddress, crossmintActionId || null, status || 'pending', ipAddress || null, nextSerial);
  return result.lastInsertRowid;
}

function updateMintStatus(id, status, walletAddress, txHash = null, costMatic = null) {
  if (txHash && costMatic != null) {
    db.prepare(`UPDATE mints SET status = ?, wallet_address = ?, crossmint_action_id = ?, mint_cost_matic = ? WHERE id = ?`).run(status, walletAddress, txHash, costMatic, id);
  } else if (txHash) {
    db.prepare(`UPDATE mints SET status = ?, wallet_address = ?, crossmint_action_id = ? WHERE id = ?`).run(status, walletAddress, txHash, id);
  } else {
    db.prepare(`UPDATE mints SET status = ?, wallet_address = ? WHERE id = ?`).run(status, walletAddress, id);
  }
}

function getNextPendingMint() {
  return db.prepare(`SELECT * FROM mints WHERE status = 'pending' ORDER BY id ASC LIMIT 1`).get();
}

// Reglas por defecto de La Chave Semanal (texto único para cliente y admin).
// Declarado antes de module.exports para evitar TDZ al requerir el módulo.
const WEEKLY_DEFAULT_RULES = '¡Trinca tu boleto esta semana y participa! Consulta las bases de participación a continuación para ver todos los detalles.';

function insertVisit(walletAddress, email, ipAddress) {
  const stmt = db.prepare(`
    INSERT INTO visits (wallet_address, email, ip_address)
    VALUES (?, ?, ?)
  `);
  stmt.run(walletAddress, email || null, ipAddress || null);
}



// Semana ISO (lunes-domingo) en hora Madrid para una fecha dada — formato 'YYYY-Www'
function _madridISOWeek(d) {
  const madrid = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const tempDate = new Date(Date.UTC(madrid.getFullYear(), madrid.getMonth(), madrid.getDate()));
  tempDate.setUTCDate(tempDate.getUTCDate() + 4 - (tempDate.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tempDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tempDate - yearStart) / 86400000) + 1) / 7);
  return `${tempDate.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function checkRecentVisit(walletAddress, hours = 12) {
  if (!walletAddress) return false;

  // Cooldown semanal (>=24h): la visita cuenta UNA vez por semana natural (lunes-domingo, Madrid)
  // Cooldown corto (<24h): mantiene el comportamiento por horas
  if (hours >= 24) {
    const currentWeek = _madridISOWeek(new Date());
    const rows = db.prepare(`
      SELECT entry_time FROM sessions
      WHERE LOWER(wallet_address) = LOWER(?)
        AND counted_as_visit = 1
        AND entry_time >= datetime('now', '-9 days')
    `).all(walletAddress);

    for (const r of rows) {
      const entryDate = new Date(r.entry_time.replace(' ', 'T') + 'Z');
      if (_madridISOWeek(entryDate) === currentWeek) return true;
    }
    return false;
  }
  const row = db.prepare(`
    SELECT entry_time FROM sessions
    WHERE LOWER(wallet_address) = LOWER(?)
      AND entry_time >= datetime('now', '-${hours} hours')
      AND counted_as_visit = 1
    LIMIT 1
  `).get(walletAddress);
  return !!row;
}


function getVisitCount(walletAddress) {
  if (!walletAddress) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM (
      SELECT date(entry_time) as day FROM sessions WHERE LOWER(wallet_address) = LOWER(?) AND counted_as_visit = 1
      UNION
      SELECT date(visited_at) as day FROM visits WHERE LOWER(wallet_address) = LOWER(?)
    )
  `).get(walletAddress, walletAddress);
  return row ? row.count : 0;
}

function getStats() {
  // Total: wallets únicas con mint, sesión o visita legacy
  const total = db.prepare(`
    SELECT COUNT(*) as count FROM (
      SELECT LOWER(wallet_address) as wallet_address FROM mints WHERE status != 'failed'
      UNION
      SELECT LOWER(wallet_address) as wallet_address FROM sessions
      UNION
      SELECT LOWER(wallet_address) as wallet_address FROM visits
    )
  `).get();

  // Nivel efectivo: mint confirma el nivel; sesión/visita sin mint = Nv1 implícito
  const byLevel = db.prepare(`
    SELECT level, level_name, COUNT(*) as count FROM (
      SELECT LOWER(wallet_address) as wallet_address, MAX(level) as level, MAX(level_name) as level_name
      FROM mints WHERE status != 'failed' GROUP BY LOWER(wallet_address)
      UNION ALL
      SELECT LOWER(wallet_address) as wallet_address, 1 as level, 'Cautivo' as level_name
      FROM (
        SELECT wallet_address FROM sessions
        UNION
        SELECT wallet_address FROM visits
      )
      WHERE LOWER(wallet_address) NOT IN (SELECT LOWER(wallet_address) FROM mints WHERE status != 'failed')
      GROUP BY LOWER(wallet_address)
    ) GROUP BY level ORDER BY level
  `).all();
  const recent = db.prepare(`
    SELECT level, level_name,
           substr(wallet_address, 1, 6) || '...' || substr(wallet_address, -6) as wallet_masked,
           minted_at, status
    FROM mints ORDER BY minted_at DESC LIMIT 20
  `).all();
  const byDate = db.prepare(`
    SELECT event_date, COUNT(*) as count
    FROM mints WHERE status != 'failed'
    GROUP BY event_date ORDER BY event_date DESC LIMIT 30
  `).all();

  // Visitas totales = sessions counted_as_visit=1 UNION legacy visits (evita doble conteo)
  const totalVisits = db.prepare(`
    SELECT COUNT(*) as count FROM (
      SELECT LOWER(wallet_address) as wallet_address, date(entry_time) as day FROM sessions WHERE counted_as_visit = 1
      UNION
      SELECT LOWER(wallet_address) as wallet_address, date(visited_at) as day FROM visits
    )
  `).get()?.count || 0;

  // Visitas por día (últimos 30 días con al menos 1 visita) — misma lógica UNION
  const visitsByDay = db.prepare(`
    SELECT day, COUNT(*) as count FROM (
      SELECT LOWER(wallet_address) as wallet_address, date(entry_time) as day FROM sessions WHERE counted_as_visit = 1
      UNION
      SELECT LOWER(wallet_address) as wallet_address, date(visited_at) as day FROM visits
    )
    GROUP BY day ORDER BY day DESC LIMIT 30
  `).all();

  // Total wallets únicas que han visitado (con o sin NFT)
  const uniqueVisitors = db.prepare(`
    SELECT COUNT(DISTINCT wallet_address) as count FROM (
      SELECT LOWER(wallet_address) as wallet_address FROM sessions WHERE counted_as_visit = 1
      UNION
      SELECT LOWER(wallet_address) as wallet_address FROM visits
    )
  `).get()?.count || 0;

  // Total mints exitosos por nivel
  const mintsByLevel = db.prepare(`
    SELECT level, COUNT(*) as count FROM mints WHERE status != 'failed' GROUP BY level ORDER BY level
  `).all();

  // Mints en blockchain real (status='success' con crossmint_action_id real o admin-direct)
  const realMintsCount = db.prepare(`
    SELECT COUNT(*) as c FROM mints WHERE status = 'success'
  `).get()?.c || 0;

  // Coste total de minteo en MATIC
  const totalMintCost = db.prepare(`
    SELECT COALESCE(SUM(mint_cost_matic), 0) as total FROM mints WHERE status = 'success' AND mint_cost_matic IS NOT NULL
  `).get()?.total || 0;

  // Historial reciente con coste
  const recentWithCost = db.prepare(`
    SELECT level, level_name,
           substr(wallet_address, 1, 6) || '...' || substr(wallet_address, -6) as wallet_masked,
           wallet_address, minted_at, status, mint_cost_matic, mint_source
    FROM mints ORDER BY minted_at DESC LIMIT 50
  `).all();

  return { total: total.count, totalMints: total.count, realMints: realMintsCount, totalMintCost,
           byLevel, recent: recentWithCost, byDate, totalVisits, visitsByDay, uniqueVisitors, mintsByLevel };
}

function getHolders(levelFilter) {
  const lvl = levelFilter && levelFilter !== 'all' ? parseInt(levelFilter) : null;

  const query = `
    WITH highest_levels AS (
      SELECT LOWER(wallet_address) as wallet, MAX(level) as level
      FROM mints WHERE status != 'failed'
      GROUP BY LOWER(wallet_address)
      UNION ALL
      SELECT LOWER(wallet_address) as wallet, 1 as level
      FROM (
        SELECT wallet_address FROM sessions
        UNION
        SELECT wallet_address FROM visits
      )
      WHERE LOWER(wallet_address) NOT IN (SELECT LOWER(wallet_address) FROM mints WHERE status != 'failed')
      GROUP BY LOWER(wallet_address)
    )
    SELECT
      h.wallet as wallet_address,
      substr(h.wallet, 1, 6) || '...' || substr(h.wallet, -6) as wallet_masked,
      h.level,
      CASE h.level
        WHEN 1 THEN 'Cautivo'
        WHEN 2 THEN 'O Cunqueiro'
        WHEN 3 THEN 'O Larpeiro'
        WHEN 4 THEN 'O Presidente do Furancho'
      END as level_name,
      COALESCE(
        (SELECT MAX(minted_at) FROM mints WHERE LOWER(wallet_address) = h.wallet AND level = h.level AND status != 'failed'),
        (SELECT MAX(entry_time) FROM sessions WHERE LOWER(wallet_address) = h.wallet AND counted_as_visit = 1),
        (SELECT MAX(visited_at) FROM visits WHERE LOWER(wallet_address) = h.wallet)
      ) as event_date,
      CASE WHEN (SELECT count(*) FROM mints WHERE LOWER(wallet_address) = h.wallet AND level = h.level AND status != 'failed') > 0 THEN 'success' ELSE 'session' END as status
    FROM highest_levels h
    ${lvl ? 'WHERE h.level = ?' : ''}
    ORDER BY event_date DESC
  `;

  return lvl ? db.prepare(query).all(lvl) : db.prepare(query).all();
}

function getMultiLevelHolders() {
  const rows = db.prepare(`
    SELECT wallet_address,
           COUNT(DISTINCT level) as levels_count,
           GROUP_CONCAT(DISTINCT level_name) as levels,
           MIN(minted_at) as first_mint,
           MAX(minted_at) as last_mint
    FROM mints WHERE status != 'failed'
    GROUP BY wallet_address
    HAVING levels_count > 1
    ORDER BY levels_count DESC
  `).all();

  return rows.map(r => {
    const visits = getVisitCount(r.wallet_address);
    const dates = db.prepare(`
      SELECT MIN(day) as first_visit, MAX(day) as last_visit FROM (
        SELECT date(entry_time) as day FROM sessions WHERE LOWER(wallet_address) = LOWER(?) AND counted_as_visit = 1
        UNION
        SELECT date(visited_at) as day FROM visits WHERE LOWER(wallet_address) = LOWER(?)
      )
    `).get(r.wallet_address, r.wallet_address);

    return {
      wallet_address: r.wallet_address,
      levels_count: r.levels_count,
      levels: r.levels,
      total_visits: visits,
      first_visit: dates?.first_visit || r.first_mint,
      last_visit: dates?.last_visit || r.last_mint
    };
  });
}

function getWalletsByLevel(levelFilter) {
  if (levelFilter && levelFilter.startsWith('0x')) {
    return [levelFilter];
  }
  if (levelFilter && levelFilter !== 'all') {
    return db.prepare(`SELECT DISTINCT wallet_address FROM mints WHERE status != 'failed' AND level = ?`)
      .all(parseInt(levelFilter))
      .map(r => r.wallet_address);
  }
  return db.prepare(`SELECT DISTINCT wallet_address FROM mints WHERE status != 'failed'`)
    .all()
    .map(r => r.wallet_address);
}

function insertMessage({ subject, body, levelFilter, recipientCount, rsvpEventId = null }) {
  const stmt = db.prepare(`
    INSERT INTO messages (subject, body, level_filter, recipient_count, rsvp_event_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(subject, body, levelFilter, recipientCount, rsvpEventId).lastInsertRowid;
}

function getMessages() {
  return db.prepare(`SELECT * FROM messages ORDER BY sent_at DESC LIMIT 50`).all();
}

function getClaimedLevels(walletAddress) {
  if (!walletAddress) return [];
  return db.prepare(`
    SELECT level FROM mints 
    WHERE LOWER(wallet_address) = LOWER(?) AND status = 'success'
  `).all(walletAddress).map(r => r.level);
}

function checkDuplicate(walletAddress, email, level) {
  let row;
  if (email) {
    row = db.prepare(`
      SELECT id FROM mints
      WHERE (LOWER(wallet_address) = LOWER(?) OR LOWER(email) = LOWER(?)) AND level = ? AND status = 'success'
    `).get(walletAddress, email.toLowerCase().trim(), level);
  } else {
    row = db.prepare(`
      SELECT id FROM mints
      WHERE LOWER(wallet_address) = LOWER(?) AND level = ? AND status = 'success'
    `).get(walletAddress, level);
  }
  return !!row;
}

// Limpia mints bloqueados (pending/failed) para un wallet+level concreto — permite reintentar
function clearStaleMint(walletAddress, level) {
  if (!walletAddress) return;
  db.prepare(`DELETE FROM mints WHERE LOWER(wallet_address) = LOWER(?) AND level = ? AND status IN ('pending', 'failed', 'pending_approval')`).run(walletAddress, level);
}

function getPendingApprovalMints() {
  return db.prepare(`
    SELECT id, wallet_address, level, level_name, minted_at, ip_address
    FROM mints WHERE status = 'pending_approval'
    ORDER BY minted_at ASC
  `).all();
}

function approveMint(id) {
  db.prepare(`UPDATE mints SET status = 'pending' WHERE id = ? AND status = 'pending_approval'`).run(id);
}

function rejectMint(id) {
  db.prepare(`UPDATE mints SET status = 'rejected_admin' WHERE id = ? AND status = 'pending_approval'`).run(id);
}


function openSession(walletAddress) {
  if (!walletAddress) return { opened: false, counted: false };
  const now = new Date();
  const madridTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const yyyy = madridTime.getFullYear();
  const mm = String(madridTime.getMonth() + 1).padStart(2, '0');
  const dd = String(madridTime.getDate()).padStart(2, '0');
  const todayMadrid = `${yyyy}-${mm}-${dd}`;

  const existing = db.prepare(`SELECT id, entry_time, counted_as_visit FROM sessions WHERE LOWER(wallet_address) = LOWER(?) AND exit_time IS NULL ORDER BY entry_time DESC LIMIT 1`).get(walletAddress);

  if (existing) {
    // Convertir la fecha de inicio de la sesión existente a fecha local Madrid
    const entryMadrid = new Date(new Date(existing.entry_time.replace(' ', 'T') + 'Z').toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const ey = entryMadrid.getFullYear();
    const em = String(entryMadrid.getMonth() + 1).padStart(2, '0');
    const ed = String(entryMadrid.getDate()).padStart(2, '0');
    const entryMadridDate = `${ey}-${em}-${ed}`;

    if (entryMadridDate !== todayMadrid) {
      // Si la sesión es de otro día, la cerramos automáticamente estableciendo exit_time a ahora
      db.prepare(`UPDATE sessions SET exit_time = datetime('now'), duration_minutes = 60 WHERE id = ?`).run(existing.id);
      console.log(`[Session] Cerrada sesión huérfana de fecha anterior (${entryMadridDate}) para la wallet ${walletAddress}`);
    } else {
      // Ya tiene sesión activa abierta hoy
      return { opened: false, counted: !!existing.counted_as_visit, alreadyOpen: true };
    }
  }

  // La visita SOLO cuenta si hay evento en la agenda y la entrada cae dentro de su
  // ventana horaria (con margen antes de la apertura para los que llegan pronto).
  const win = getActiveEventWindow();
  const inEventWindow = !!win && win.nowMs >= (win.startMs - EVENT_EARLY_MARGIN_MS) && win.nowMs <= win.endMs;

  // Evitar exploit de acumulación: máximo una visita contada por semana natural
  const alreadyVisitedThisWeek = checkRecentVisit(walletAddress, 168);
  const countedAsVisit = (inEventWindow && !alreadyVisitedThisWeek) ? 1 : 0;

  db.prepare(`INSERT INTO sessions (wallet_address, counted_as_visit) VALUES (?, ?)`).run(walletAddress, countedAsVisit);

  if (inEventWindow && walletAddress) {
    try {
      db.prepare(`
        UPDATE push_subscriptions
        SET channels = CASE 
          WHEN channels IS NULL OR channels = '' THEN 'local-live'
          WHEN channels NOT LIKE '%local-live%' THEN channels || ',local-live'
          ELSE channels
        END
        WHERE LOWER(wallet_address) = LOWER(?)
      `).run(walletAddress);
    } catch(e) {}
  }

  return { opened: true, counted: countedAsVisit === 1, hasEventNow: inEventWindow, alreadyVisitedThisWeek };
}

function closeSession(walletAddress) {
  if (!walletAddress) return;
  // Solo registra la salida y duración — counted_as_visit ya fue fijado en openSession (en la entrada)
  const session = db.prepare(`
    SELECT id, entry_time FROM sessions
    WHERE LOWER(wallet_address) = LOWER(?) AND exit_time IS NULL
    ORDER BY entry_time DESC LIMIT 1
  `).get(walletAddress);

  if (session) {
    const entryDate = new Date(session.entry_time + 'Z');
    const now = new Date();
    let diffMinutes = Math.floor((now - entryDate) / 60000);
    if (diffMinutes > 12 * 60 || diffMinutes < 0) diffMinutes = 60;
    db.prepare(`
      UPDATE sessions SET exit_time = datetime('now'), duration_minutes = ?
      WHERE id = ?
    `).run(diffMinutes, session.id);

    try {
      db.prepare(`
        UPDATE push_subscriptions
        SET channels = REPLACE(REPLACE(REPLACE(channels, ',local-live', ''), 'local-live,', ''), 'local-live', '')
        WHERE LOWER(wallet_address) = LOWER(?)
      `).run(walletAddress);
    } catch(e) {}
  }
}

function savePushSubscription(walletAddress, subscription, channels = null) {
  let channelsStr = 'general';
  if (Array.isArray(channels)) {
    channelsStr = channels.join(',');
  } else if (typeof channels === 'string') {
    channelsStr = channels;
  }
  db.prepare(`
    INSERT INTO push_subscriptions (wallet_address, endpoint, p256dh, auth, channels)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET 
      wallet_address = excluded.wallet_address,
      channels = excluded.channels
  `).run(walletAddress || null, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, channelsStr);
}

function getAllPushSubscriptions() {
  return db.prepare(`SELECT * FROM push_subscriptions`).all();
}

function deletePushSubscription(endpoint) {
  db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
}

function getEvents() {
  const events = db.prepare(`
    SELECT e.*, COUNT(r.id) as rsvp_count
    FROM events e LEFT JOIN rsvps r ON e.id = r.event_id
    WHERE e.active = 1
    GROUP BY e.id
    ORDER BY e.event_date ASC
  `).all();

  events.forEach(ev => {
    const rsvps = db.prepare(`
      SELECT r.wallet_address, r.allergens,
        (SELECT m.email FROM mints m
           WHERE LOWER(m.wallet_address) = LOWER(r.wallet_address) AND m.email IS NOT NULL AND m.email != ''
           ORDER BY m.id DESC LIMIT 1) AS email
      FROM rsvps r WHERE r.event_id = ?
      ORDER BY r.created_at ASC
    `).all(ev.id);
    const summary = {};
    let eatAllCount = 0;
    const allergenPeople = []; // desglose por persona: [{ label, allergens: [ids] }]
    rsvps.forEach(r => {
      const isEatAll = !r.allergens || r.allergens.trim() === '' || r.allergens === 'ninguno' || r.allergens === 'tododo';
      const list = isEatAll ? [] : r.allergens.split(',').map(x => x.trim()).filter(Boolean);
      if (list.length === 0) {
        eatAllCount++;
      } else {
        list.forEach(a => {
          summary[a] = (summary[a] || 0) + 1;
        });
        const shortWallet = r.wallet_address ? `${r.wallet_address.slice(0, 6)}…${r.wallet_address.slice(-4)}` : '';
        allergenPeople.push({ label: r.email || shortWallet, allergens: list });
      }
    });
    ev.allergens_summary = summary; // se mantiene por compatibilidad
    ev.eat_all_count = eatAllCount;
    ev.allergen_people = allergenPeople; // una entrada por comensal con alérgenos
  });

  return events;
}

function toggleRsvp(eventId, walletAddress, allergens = null) {
  const existing = db.prepare(`SELECT id FROM rsvps WHERE LOWER(wallet_address) = LOWER(?) AND event_id = ?`).get(walletAddress, eventId);
  if (existing) {
    db.prepare(`DELETE FROM rsvps WHERE id = ?`).run(existing.id);
    return false; // cancelado
  } else {
    db.prepare(`INSERT INTO rsvps (event_id, wallet_address, allergens) VALUES (?,?,?)`).run(eventId, walletAddress, allergens);
    return true; // apuntado
  }
}

function getRsvpStatus(walletAddress) {
  return db.prepare(`SELECT event_id FROM rsvps WHERE LOWER(wallet_address)=LOWER(?)`).all(walletAddress).map(r => r.event_id);
}

// U1: detalle de los RSVP del cliente (evento + alérgenos), recientes primero — para prefill y edición.
function getRsvpsDetail(walletAddress) {
  return db.prepare(`SELECT event_id, allergens FROM rsvps WHERE LOWER(wallet_address)=LOWER(?) ORDER BY id DESC`).all(walletAddress);
}

// U1: actualiza los alérgenos de un RSVP existente sin desapuntar. Devuelve nº de filas afectadas.
function setRsvpAllergens(eventId, walletAddress, allergens) {
  return db.prepare(`UPDATE rsvps SET allergens=? WHERE LOWER(wallet_address)=LOWER(?) AND event_id=?`).run(allergens, walletAddress, eventId).changes;
}

function createEvent({ date, title, description, startTime, endTime }) {
  return db.prepare(`
    INSERT INTO events (event_date, title, description, start_time, end_time)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(event_date) DO UPDATE SET title=excluded.title, description=excluded.description, start_time=excluded.start_time, end_time=excluded.end_time
  `).run(date, title || 'Furancho Sessions', description || null, startTime || '19:00', endTime || '23:59').lastInsertRowid;
}

function updateEvent(id, { title, description, date, active, startTime, endTime }) {
  const fields = [];
  const vals = [];
  if (title !== undefined)       { fields.push('title = ?');       vals.push(title); }
  if (description !== undefined) { fields.push('description = ?'); vals.push(description); }
  if (date !== undefined)        { fields.push('event_date = ?');  vals.push(date); }
  if (active !== undefined)      { fields.push('active = ?');      vals.push(active ? 1 : 0); }
  if (startTime !== undefined)   { fields.push('start_time = ?');  vals.push(startTime); }
  if (endTime !== undefined)     { fields.push('end_time = ?');    vals.push(endTime); }
  if (!fields.length) return;
  vals.push(id);
  db.prepare(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

function deleteEvent(id) {
  db.prepare(`UPDATE events SET active = 0 WHERE id = ?`).run(id);
}

function getAllEvents() {
  return db.prepare(`
    SELECT e.*, COUNT(r.id) as rsvp_count
    FROM events e LEFT JOIN rsvps r ON e.id = r.event_id
    GROUP BY e.id
    ORDER BY e.event_date ASC
  `).all();
}

// Textos canónicos de cada evento — editables desde el admin, pero estos son el fallback si la BD se reinicia.
// Para añadir o cambiar una descripción desde el código: edita el array y añade la fecha a FORCED_UPDATE_DATES.
const EVENT_SEED = [
  {
    date: '2026-06-04',
    title: 'Furancho Sessions — 4 Junio',
    description: 'Menudo estreno nos marcamos en el primer furancho, ¡carallo! 🍷✨\nJugaba la selección en la ciudad y el estadio estaba a tope, pero con nosotros se quedó la gente que sabe divertirse de verdad. ¡Qué nivelazo de público!\nVaya lujazo de noche con Carmen Rey y Rubén Appratto al micro, y el gran Tito Fernández (chef e ideólogo de todo este invento) saliéndose.'
  },
  {
    date: '2026-06-11',
    title: 'Furancho Sessions — 11 Junio',
    description: 'Volvemos a activar el furancho con DJ y el lujazo de tener otra vez con nosotros a Carmen Rey para darle nivelazo a la noche. Suma a eso 5 tapas espectaculares, buen vino y bebida para arreglar el mundo desde la tarde hasta la noche.'
  },
  {
    date: '2026-06-18',
    title: 'Furancho Sessions — 18 Junio',
    description: 'Una cata selecta acompañada de las mejores tapas de temporada. Descubre nuevos sabores en un ambiente único y relajado entre amigos.'
  },
  {
    date: '2026-06-25',
    title: 'Furancho Sessions — 25 Junio',
    description: '¡Bua, neno, que es esta noche! Estrenamos el furancho en la terraza del Parrote (sí, la que está pegada al hotel, no tiene pérdida). 🌊🔥\nSe viene una noche bastante más intensa y divertida de lo normal. Tendremos música, fogata simbólica y hasta ritual de limpieza con el agua purificadora de San Juan para espantar el meigallo. Todo esto, claro, con nuestro menú especial de tapas, los vinos galardonados... y alguna sorpresa más que no os voy a contar.'
  },
  {
    date: '2026-07-02',
    title: 'Furancho Sessions — 2 Julio',
    description: 'Algo está preparándose. No podemos decir mucho… solo que merece la pena estar. Apúntate y descúbrelo.'
  },
];

// Fechas cuya descripción debe actualizarse aunque ya exista en BD (cuando cambias el texto desde aquí).
// Añade la fecha aquí cuando quieras forzar la actualización desde código.
const FORCED_UPDATE_DATES = ['2026-06-25'];

function seedEvents() {
  const dates = EVENT_SEED;
  // UPSERT: inserta si no existe, actualiza título/descripción si cambian
  // NUNCA borra — los IDs se mantienen estables entre reinicios para que las reservas no se huerfanen
  dates.forEach(({ date, title, description }) => {
    db.prepare(`
      INSERT INTO events (event_date, title, description) VALUES (?, ?, ?)
      ON CONFLICT(event_date) DO NOTHING
    `).run(date, title, description);
  });
}
try { seedEvents(); } catch(e) { console.warn('[DB] seedEvents falló (posible lock en deploy):', e.message); }

// Forzar actualización de eventos cuya descripción ha sido editada desde el código.
// Solo actualiza las fechas listadas en FORCED_UPDATE_DATES — el resto no se toca.
// Cuando el admin edite desde móvil y quiera persistir, añade la fecha aquí y modifica EVENT_SEED arriba.
try {
  FORCED_UPDATE_DATES.forEach(date => {
    const entry = EVENT_SEED.find(e => e.date === date);
    if (!entry) return;
    db.prepare(`UPDATE events SET title = ?, description = ? WHERE event_date = ?`)
      .run(entry.title, entry.description, date);
  });
} catch(e) { console.warn('[DB] forced event update falló:', e.message); }

function getVipCapacity(eventId) {
  const event = db.prepare(`SELECT vip_max FROM events WHERE id=?`).get(eventId);
  const max = event ? (event.vip_max ?? 15) : 15;
  const used = db.prepare(`
    SELECT COALESCE(SUM(group_size),0) as total
    FROM vip_reservations WHERE event_id=? AND status != 'cancelled'
  `).get(eventId);
  return { used: used.total, remaining: max - used.total, max };
}

function setVipMax(eventId, newMax) {
  if (newMax < 0) throw new Error('La capacidad no puede ser negativa.');
  db.prepare(`UPDATE events SET vip_max=? WHERE id=?`).run(newMax, eventId);
  return getVipCapacity(eventId);
}

function createVipReservation({ eventId, walletAddress, phone, groupSize, notes }) {
  const cap = getVipCapacity(eventId);
  if (groupSize < 4) throw new Error('El mínimo es 4 personas.');
  if (groupSize > cap.remaining) throw new Error(`Solo quedan ${cap.remaining} plazas VIP disponibles.`);
  const existing = db.prepare(`SELECT id FROM vip_reservations WHERE event_id=? AND wallet_address=?`).get(eventId, walletAddress);
  if (existing) throw new Error('Ya tienes una reserva para este evento.');
  const result = db.prepare(`INSERT INTO vip_reservations (event_id, wallet_address, phone, group_size, notes) VALUES (?,?,?,?,?)`)
    .run(eventId, walletAddress, phone, groupSize, notes || null);
  return {
    capacity: getVipCapacity(eventId),
    reservationId: result.lastInsertRowid
  };
}

function getVipReservations(eventId) {
  return db.prepare(`
    SELECT id, substr(wallet_address,1,6)||'...'||substr(wallet_address,-4) as wallet_masked,
           phone, group_size, status, notes, alias, created_at
    FROM vip_reservations WHERE event_id=? ORDER BY created_at ASC
  `).all(eventId);
}

function getVipReservation(reservationId) {
  return db.prepare(`
    SELECT r.id, r.wallet_address, r.phone, r.group_size, r.status, r.notes, r.alias, r.event_id,
           e.title as event_title, e.event_date
    FROM vip_reservations r JOIN events e ON r.event_id = e.id
    WHERE r.id=?
  `).get(reservationId);
}

// Genera el "nombre de la mesa": un alias gracioso, anónimo y gallego (furancho + amistad).
// Único dentro del mismo evento para que el patrón no confunda dos mesas la misma noche.
const VIP_ALIAS_GRUPOS = [
  'A Cuadrilla', 'A Tropa', 'A Panda', 'A Peña', 'A Troula', 'A Esmorga',
  'A Xuntanza', 'A Parrulada', 'Os Amigos', 'Os Riquiños', 'Os Larpeiros',
  'A Galería', 'O Clube', 'A Pandilla', 'Os Featos'
];
const VIP_ALIAS_COMPLEMENTOS = [
  'do Albariño', 'do Ribeiro', 'do Godello', 'do Mencía', 'do Polbo',
  'dos Percebes', 'dos Mexillóns', 'do Lacón', 'dos Grelos', 'da Queimada',
  'da Empanada', 'do Furancho', 'da Gaita', 'do Queixo', 'da Ría',
  'do Faro', 'dos Pementos', 'da Morriña', 'da Centola', 'do Caldiño'
];

function generateVipAlias(eventId) {
  const taken = new Set(
    db.prepare(`SELECT alias FROM vip_reservations WHERE event_id=? AND alias IS NOT NULL`)
      .all(eventId).map(r => r.alias)
  );
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  let name;
  for (let i = 0; i < 60; i++) {
    name = `${pick(VIP_ALIAS_GRUPOS)} ${pick(VIP_ALIAS_COMPLEMENTOS)}`;
    if (!taken.has(name)) return name;
  }
  return name; // fallback improbable: todas las combinaciones agotadas
}

// Devuelve el alias vigente de la reserva (lo genera la primera vez que se confirma).
function updateVipStatus(reservationId, status) {
  if (status === 'confirmed') {
    const row = db.prepare(`SELECT event_id, alias FROM vip_reservations WHERE id=?`).get(reservationId);
    if (row && !row.alias) {
      const alias = generateVipAlias(row.event_id);
      db.prepare(`UPDATE vip_reservations SET status=?, alias=? WHERE id=?`).run(status, alias, reservationId);
      return alias;
    }
    db.prepare(`UPDATE vip_reservations SET status=? WHERE id=?`).run(status, reservationId);
    return row ? row.alias : null;
  }
  db.prepare(`UPDATE vip_reservations SET status=? WHERE id=?`).run(status, reservationId);
  return null;
}

function getSessionAnalytics() {
  const avgByLevel = db.prepare(`
    SELECT m.level, m.level_name,
           ROUND(AVG(s.duration_minutes), 1) as avg_minutes,
           COUNT(DISTINCT s.wallet_address) as unique_clients,
           COUNT(s.id) as total_sessions
    FROM sessions s
    JOIN (SELECT wallet_address, MAX(level) as level, MAX(level_name) as level_name FROM mints WHERE status='success' GROUP BY wallet_address) m
      ON s.wallet_address = m.wallet_address
    WHERE s.exit_time IS NOT NULL AND s.duration_minutes > 0
    GROUP BY m.level ORDER BY m.level
  `).all();

  const topClients = db.prepare(`
    SELECT wallet_address,
           substr(wallet_address,1,6)||'...'||substr(wallet_address,-4) as wallet_masked,
           COUNT(*) as total_visits,
           ROUND(AVG(duration_minutes),1) as avg_stay,
           MAX(entry_time) as last_visit
    FROM sessions WHERE exit_time IS NOT NULL
    GROUP BY wallet_address ORDER BY total_visits DESC LIMIT 10
  `).all();

  const activeNow = db.prepare(`SELECT COUNT(DISTINCT wallet_address) as count FROM sessions WHERE exit_time IS NULL`).get();
  const avgGlobal = db.prepare(`SELECT ROUND(AVG(duration_minutes),1) as avg FROM sessions WHERE exit_time IS NOT NULL AND duration_minutes > 0 AND duration_minutes < 300`).get();

  return { avgByLevel, topClients, activeNow: activeNow.count, avgGlobal: avgGlobal.avg };
}

// Devuelve el evento activo de la agenda para la fecha Madrid dada (o null)
function getEventForMadridDate(madridDateStr) {
  return db.prepare(`SELECT id, event_date, start_time, end_time FROM events WHERE event_date = ? AND active = 1`).get(madridDateStr) || null;
}

// Convierte una hora de pared en Madrid (mismo marco que el resto de cálculos) a milisegundos comparables
function _madridWallMs(dateStr) {
  // dateStr en formato 'YYYY-MM-DD HH:MM:SS' (UTC, como lo guarda SQLite con datetime('now'))
  return new Date(new Date(dateStr.replace(' ', 'T') + 'Z').toLocaleString('en-US', { timeZone: 'Europe/Madrid' })).getTime();
}

// Margen antes de la apertura del evento en el que la entrada ya cuenta (visita Y sorteos).
// Mismo valor para ambos: si la visita suma, el cliente también está en el bombo.
const EVENT_EARLY_MARGIN_MS = 60 * 60 * 1000;

// Ventana del evento activo aplicable "ahora": el de hoy, o el de ayer si cruza medianoche.
// Devuelve { event, eventDayStr, startMs, endMs, nowMs } en marco "hora de pared Madrid", o null si no hay evento.
function getActiveEventWindow() {
  const now = new Date();
  const madridNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const madridDateStr = fmt(madridNow);

  let event = getEventForMadridDate(madridDateStr);
  let eventDayStr = madridDateStr;
  if (!event) {
    // ¿Hay un evento de ayer cuya ventana cruza medianoche y sigue activa ahora?
    const yest = new Date(madridNow); yest.setDate(yest.getDate() - 1);
    const yEvent = getEventForMadridDate(fmt(yest));
    if (yEvent) {
      const [ysh, ysm] = (yEvent.start_time || '19:00').split(':').map(Number);
      const [yeh, yem] = (yEvent.end_time || '23:59').split(':').map(Number);
      if ((yeh * 60 + yem) <= (ysh * 60 + ysm)) { // cruza medianoche
        event = yEvent; eventDayStr = fmt(yest);
      }
    }
  }
  if (!event) return null;

  const [sh, sm] = (event.start_time || '19:00').split(':').map(Number);
  const [eh, em] = (event.end_time || '23:59').split(':').map(Number);
  const [ey, emo, ed] = eventDayStr.split('-').map(Number);
  const dayStart = new Date(ey, emo - 1, ed, 0, 0, 0, 0);
  const startMs = dayStart.getTime() + (sh * 60 + sm) * 60000;
  let endMs = dayStart.getTime() + (eh * 60 + em) * 60000;
  if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000; // ventana cruza medianoche

  return { event, eventDayStr, startMs, endMs, nowMs: madridNow.getTime() };
}

function getEligibleRaffleParticipants() {
  // Elegibles para sorteos en vivo: SOLO los que ficharon entrada DENTRO de la ventana
  // horaria de un evento de la agenda ese día. Si no hay evento hoy, nadie es elegible.
  const win = getActiveEventWindow();
  if (!win) {
    return [];
  }

  // Si la hora actual no está dentro del horario del evento (incluido el margen inicial)
  if (win.nowMs < (win.startMs - EVENT_EARLY_MARGIN_MS) || win.nowMs > win.endMs) {
    return [];
  }

  const { eventDayStr, startMs, endMs } = win;

  // Candidatos: sesiones abiertas hoy (o día siguiente por si cruza medianoche).
  // Elegible = sigue DENTRO ahora mismo (exit_time IS NULL).
  const rows = db.prepare(`
    SELECT DISTINCT wallet_address, entry_time FROM sessions
    WHERE (date(entry_time) = ? OR date(entry_time) = date(?, '+1 day'))
      AND exit_time IS NULL
  `).all(eventDayStr, eventDayStr);

  const eligible = new Set();
  rows.forEach(r => {
    const entryMs = _madridWallMs(r.entry_time);
    // Para entrar en el bombo, el fichaje debió hacerse dentro de la ventana permitida
    if (entryMs >= (startMs - EVENT_EARLY_MARGIN_MS) && entryMs <= endMs) {
      eligible.add(r.wallet_address);
    }
  });
  return [...eligible];
}

// Re-evalúa las sesiones abiertas cuando la ventana del evento (con margen) está activa:
// quien fichó demasiado pronto (o antes de que el evento existiera en la agenda) y sigue
// dentro recupera su visita. Se ejecuta cada minuto desde server.js.
function countPendingVisitsDuringEvent() {
  const win = getActiveEventWindow();
  if (!win) return 0;
  if (win.nowMs < (win.startMs - EVENT_EARLY_MARGIN_MS) || win.nowMs > win.endMs) return 0;

  const open = db.prepare(`
    SELECT id, wallet_address FROM sessions
    WHERE exit_time IS NULL AND counted_as_visit = 0
      AND (date(entry_time) = ? OR date(entry_time) = date(?, '+1 day'))
  `).all(win.eventDayStr, win.eventDayStr);

  let fixed = 0;
  const stmt = db.prepare(`UPDATE sessions SET counted_as_visit = 1 WHERE id = ?`);
  open.forEach(s => {
    // Respetar la regla de 1 visita por semana (la propia sesión no cuenta: está a 0)
    if (!checkRecentVisit(s.wallet_address, 168)) {
      stmt.run(s.id);
      fixed++;
    }
  });
  if (fixed > 0) console.log(`[Session] ${fixed} sesión(es) abiertas re-marcadas como visita al activarse la ventana del evento`);
  return fixed;
}

// Convierte una fecha y hora local de Madrid a una cadena UTC (formato YYYY-MM-DD HH:MM:SS)
function madridToUTC(madridDateStr, madridTimeStr) {
  const wallUtc = new Date(`${madridDateStr}T${madridTimeStr}:00Z`);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  });
  const parts = formatter.formatToParts(wallUtc);
  const partMap = {};
  parts.forEach(p => partMap[p.type] = p.value);
  
  const formattedMadrid = new Date(`${partMap.year}-${partMap.month}-${partMap.day}T${partMap.hour}:${partMap.minute}:${partMap.second}Z`);
  const offsetMs = formattedMadrid.getTime() - wallUtc.getTime();
  const utcDate = new Date(wallUtc.getTime() - offsetMs);
  
  const y = utcDate.getUTCFullYear();
  const m = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utcDate.getUTCDate()).padStart(2, '0');
  const hh = String(utcDate.getUTCHours()).padStart(2, '0');
  const mm = String(utcDate.getUTCMinutes()).padStart(2, '0');
  const ss = String(utcDate.getUTCSeconds()).padStart(2, '0');
  
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

// Cierre automático de sesiones: ocurre cuando TERMINA el horario del evento de la agenda
// (no a una hora fija). Se llama cada minuto desde server.js; sólo actúa al pasar la hora de cierre.
function autoCloseSessionsAfterEvent() {
  const now = new Date();
  const madridNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayStr = fmt(madridNow);
  const yest = new Date(madridNow); yest.setDate(yest.getDate() - 1);
  const yestStr = fmt(yest);

  // Evento relevante: el de hoy, o el de ayer si su ventana cruza medianoche
  let event = getEventForMadridDate(todayStr);
  let eventDayStr = todayStr;
  if (!event) {
    const yEvent = getEventForMadridDate(yestStr);
    if (yEvent) {
      const [ysh, ysm] = (yEvent.start_time || '19:00').split(':').map(Number);
      const [yeh, yem] = (yEvent.end_time || '23:59').split(':').map(Number);
      if ((yeh * 60 + yem) <= (ysh * 60 + ysm)) { event = yEvent; eventDayStr = yestStr; }
    }
  }
  if (!event) return 0; // sin evento → no se cierra nada automáticamente

  // Calcular fin del evento en el mismo marco que getEligibleRaffleParticipants
  const [sh, sm] = (event.start_time || '19:00').split(':').map(Number);
  const [eh, em] = (event.end_time || '23:59').split(':').map(Number);
  const [ey, emo, ed] = eventDayStr.split('-').map(Number);
  const dayStart = new Date(ey, emo - 1, ed, 0, 0, 0, 0);
  const startMs = dayStart.getTime() + (sh * 60 + sm) * 60000;
  let endMs = dayStart.getTime() + (eh * 60 + em) * 60000;
  
  let endDayStr = eventDayStr;
  if (endMs <= startMs) {
    endMs += 24 * 60 * 60 * 1000; // cruza medianoche
    const endDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const ey_end = endDay.getFullYear();
    const em_end = String(endDay.getMonth() + 1).padStart(2, '0');
    const ed_end = String(endDay.getDate()).padStart(2, '0');
    endDayStr = `${ey_end}-${em_end}-${ed_end}`;
  }

  if (madridNow.getTime() < endMs) return 0; // el evento aún no ha terminado

  // Cerrar sesiones abiertas del día del evento (y siguiente por si cruza medianoche)
  const open = db.prepare(`SELECT id, entry_time FROM sessions WHERE exit_time IS NULL AND (date(entry_time) = ? OR date(entry_time) = date(?, '+1 day'))`).all(eventDayStr, eventDayStr);
  if (open.length === 0) return 0;

  const eh_str = String(eh).padStart(2, '0');
  const em_str = String(em).padStart(2, '0');
  const exitTimeUtcStr = madridToUTC(endDayStr, `${eh_str}:${em_str}`);

  const stmt = db.prepare(`
    UPDATE sessions
    SET exit_time = ?,
        auto_closed = 1,
        duration_minutes = ?
    WHERE id = ?
  `);

  const cleanPushStmt = db.prepare(`
    UPDATE push_subscriptions
    SET channels = REPLACE(REPLACE(REPLACE(channels, ',local-live', ''), 'local-live,', ''), 'local-live', '')
    WHERE LOWER(wallet_address) = LOWER(?)
  `);

  open.forEach(s => {
    const entryDate = new Date(s.entry_time.replace(' ', 'T') + 'Z');
    const exitDate = new Date(exitTimeUtcStr.replace(' ', 'T') + 'Z');
    let diffMinutes = Math.floor((exitDate - entryDate) / 60000);
    if (diffMinutes > 12 * 60 || diffMinutes < 0) diffMinutes = 60;
    stmt.run(exitTimeUtcStr, diffMinutes, s.id);
    try {
      cleanPushStmt.run(s.wallet_address);
    } catch(e) {}
  });

  console.log(`[Auto-checkout fin evento ${event.end_time}] Sesiones cerradas: ${open.length} con exit_time = ${exitTimeUtcStr}`);
  return open.length;
}
// Alias retrocompatible
const autoCloseSessionsAt23 = autoCloseSessionsAfterEvent;

function insertRaffle(prize, winnerWallet, verificationCode, participantWallets = [], targetLevel = null, prizeDetails = null, prizeImage = null, establishment = null, type = 'night', hideName = 0, participantLevel = null) {
  // Plazo de aceptación: 10s de animación + 600s de ventana de aceptación (debe coincidir
  // con acceptWindow en doLaunch — el sweeper de expiración usa este deadline)
  const deadline = new Date(Date.now() + 610000).toISOString().replace('T', ' ').slice(0, 19);
  const id = db.prepare(`
    INSERT INTO raffles (prize, winner_wallet, verification_code, status, acceptance_deadline, target_level, prize_details, prize_image, establishment, type, hide_name, participant_level)
    VALUES (?, ?, ?, 'pending_acceptance', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(prize, winnerWallet, verificationCode, deadline, targetLevel, prizeDetails, prizeImage, establishment, type, hideName ? 1 : 0, participantLevel || null).lastInsertRowid;
  if (participantWallets.length) {
    const stmt = db.prepare(`INSERT OR IGNORE INTO raffle_participants (raffle_id, wallet_address) VALUES (?, ?)`);
    participantWallets.forEach(w => stmt.run(id, w));
  }
  return id;
}

function acceptRaffle(raffleId, walletAddress) {
  const raffle = db.prepare(`SELECT winner_wallet, status, target_level, prize FROM raffles WHERE id = ?`).get(raffleId);
  if (!raffle) throw new Error('Sorteo no encontrado');
  if (!raffle.winner_wallet || !walletAddress || raffle.winner_wallet.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error('No eres el ganador');
  }
  if (raffle.status !== 'pending_acceptance') throw new Error('Este sorteo ya no está activo');
  db.prepare(`UPDATE raffles SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?`).run(raffleId);
  return raffle;
}

function rejectRaffle(raffleId, note) {
  db.prepare(`UPDATE raffles SET status = 'rejected', rejected_at = datetime('now'), rejection_note = ? WHERE id = ?`)
    .run(note || null, raffleId);
}

function collectRaffle(raffleId, adminNote) {
  db.prepare(`
    UPDATE raffles SET collected = 1, status = 'collected', collected_at = datetime('now'), collected_by = ?
    WHERE id = ?
  `).run(adminNote || null, raffleId);
}

function getRaffleHistory() {
  return db.prepare(`
    SELECT id, prize,
           substr(winner_wallet,1,6)||'...'||substr(winner_wallet,-4) as wallet_masked,
           winner_wallet, verification_code, created_at,
           collected, collected_at, collected_by, status, rejection_note, accepted_at, target_level,
           prize_details, prize_image, establishment, type, hide_name
    FROM raffles
    ORDER BY created_at DESC LIMIT 100
  `).all();
}

function getMyWins(walletAddress) {
  if (!walletAddress) return [];
  return db.prepare(`
    SELECT id, prize, verification_code, created_at, collected, collected_at, status, target_level,
           prize_details, prize_image, establishment
    FROM raffles WHERE LOWER(winner_wallet) = LOWER(?) AND status IN ('accepted','collected')
    ORDER BY created_at DESC LIMIT 20
  `).all(walletAddress);
}

function getRaffleParticipation(walletAddress) {
  if (!walletAddress) return [];
  const lowerWallet = walletAddress.toLowerCase();
  return db.prepare(`
    SELECT r.id, r.prize, r.status, r.created_at, r.collected, r.collected_at, r.rejection_note, r.acceptance_deadline,
           CASE WHEN LOWER(r.winner_wallet) = ? THEN 1 ELSE 0 END as is_winner,
           CASE WHEN LOWER(r.winner_wallet) = ? THEN r.verification_code ELSE NULL END as verification_code,
           CASE WHEN LOWER(r.winner_wallet) = ? THEN r.prize_details ELSE NULL END as prize_details,
           CASE WHEN LOWER(r.winner_wallet) = ? THEN r.prize_image ELSE NULL END as prize_image,
           CASE WHEN LOWER(r.winner_wallet) = ? THEN r.establishment ELSE NULL END as establishment
    FROM raffles r
    WHERE r.id IN (SELECT raffle_id FROM raffle_participants WHERE LOWER(wallet_address) = ?)
       OR LOWER(r.winner_wallet) = ?
    ORDER BY r.created_at DESC LIMIT 30
  `).all(lowerWallet, lowerWallet, lowerWallet, lowerWallet, lowerWallet, lowerWallet, lowerWallet);
}

function getRaffleById(id) {
  return db.prepare(`SELECT * FROM raffles WHERE id = ?`).get(id);
}

function getPrizePresets() {
  return db.prepare(`SELECT id, name FROM prize_presets WHERE active = 1 ORDER BY created_at ASC`).all();
}

function addPrizePreset(name) {
  return db.prepare(`INSERT INTO prize_presets (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET active=1`).run(name).lastInsertRowid;
}

function deletePrizePreset(id) {
  db.prepare(`UPDATE prize_presets SET active = 0 WHERE id = ?`).run(id);
}

function getRaffleCountTonight() {
  return db.prepare(`SELECT COUNT(*) as count FROM raffles WHERE date(created_at) = date('now')`).get()?.count || 0;
}

function getScheduledRaffles(eventDate) {
  const q = eventDate
    ? `SELECT * FROM scheduled_raffles WHERE event_date = ? ORDER BY scheduled_time ASC`
    : `SELECT * FROM scheduled_raffles WHERE event_date >= date('now') ORDER BY event_date ASC, scheduled_time ASC LIMIT 30`;
  return eventDate ? db.prepare(q).all(eventDate) : db.prepare(q).all();
}

function createScheduledRaffle({ eventDate, scheduledTime, prize, targetLevel, participantLevel, type, hideName, prizeDetails, prizeImage, establishment }) {
  return db.prepare(`INSERT INTO scheduled_raffles (event_date, scheduled_time, prize, target_level, participant_level, type, hide_name, prize_details, prize_image, establishment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventDate, scheduledTime, prize, targetLevel || null, participantLevel || null, type || 'night', hideName ? 1 : 0, prizeDetails || null, prizeImage || null, establishment || null).lastInsertRowid;
}

function updateScheduledRaffle(id, { eventDate, scheduledTime, prize, status, targetLevel, participantLevel, type, hideName, prizeDetails, prizeImage, establishment }) {
  const fields = [], vals = [];
  if (eventDate !== undefined)       { fields.push('event_date = ?');        vals.push(eventDate); }
  if (scheduledTime !== undefined)   { fields.push('scheduled_time = ?');    vals.push(scheduledTime); }
  if (prize !== undefined)           { fields.push('prize = ?');             vals.push(prize); }
  if (status !== undefined)          { fields.push('status = ?');            vals.push(status); }
  if (targetLevel !== undefined)     { fields.push('target_level = ?');      vals.push(targetLevel); }
  if (participantLevel !== undefined){ fields.push('participant_level = ?'); vals.push(participantLevel); }
  if (type !== undefined)            { fields.push('type = ?');              vals.push(type); }
  if (hideName !== undefined)        { fields.push('hide_name = ?');         vals.push(hideName ? 1 : 0); }
  if (prizeDetails !== undefined)    { fields.push('prize_details = ?');     vals.push(prizeDetails); }
  if (prizeImage !== undefined)      { fields.push('prize_image = ?');       vals.push(prizeImage); }
  if (establishment !== undefined)   { fields.push('establishment = ?');     vals.push(establishment); }
  if (!fields.length) return;
  vals.push(id);
  db.prepare(`UPDATE scheduled_raffles SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

function deleteScheduledRaffle(id) {
  db.prepare(`DELETE FROM scheduled_raffles WHERE id = ?`).run(id);
}

function linkScheduledRaffle(scheduledId, raffleId) {
  db.prepare(`UPDATE scheduled_raffles SET status = 'launched', raffle_id = ? WHERE id = ?`).run(raffleId, scheduledId);
}

const ALLOWED_REACTIONS = ['🍷', '👍', '🔥', '🙌', '😂'];

function addReaction(messageId, emoji, walletAddress) {
  if (!ALLOWED_REACTIONS.includes(emoji)) throw new Error('Emoji no permitido');
  // Si ya reaccionó, actualiza el emoji
  db.prepare(`
    INSERT INTO message_reactions (message_id, emoji, wallet_address)
    VALUES (?, ?, ?)
    ON CONFLICT(message_id, wallet_address) DO UPDATE SET emoji = excluded.emoji
  `).run(messageId, emoji, walletAddress || null);
}

function getReactions(messageId) {
  const rows = db.prepare(`
    SELECT emoji, COUNT(*) as count
    FROM message_reactions WHERE message_id = ?
    GROUP BY emoji
  `).all(messageId);
  const result = {};
  ALLOWED_REACTIONS.forEach(e => { result[e] = 0; });
  rows.forEach(r => { result[r.emoji] = r.count; });
  return result;
}

function getReactionsForMessages(messageIds) {
  if (!messageIds.length) return {};
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT message_id, emoji, COUNT(*) as count
    FROM message_reactions WHERE message_id IN (${placeholders})
    GROUP BY message_id, emoji
  `).all(...messageIds);
  const result = {};
  messageIds.forEach(id => {
    result[id] = {};
    ALLOWED_REACTIONS.forEach(e => { result[id][e] = 0; });
  });
  rows.forEach(r => { if (result[r.message_id]) result[r.message_id][r.emoji] = r.count; });
  return result;
}

function getEventSessions(dateFilter) {
  // dateFilter: 'YYYY-MM-DD' o null para hoy en zona España
  let day = dateFilter;
  if (!day) {
    const now = new Date();
    const madridTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const yyyy = madridTime.getFullYear();
    const mm = String(madridTime.getMonth() + 1).padStart(2, '0');
    const dd = String(madridTime.getDate()).padStart(2, '0');
    day = `${yyyy}-${mm}-${dd}`;
  }
  // Para el 4 jun excluir scans de prueba (antes de 19:30 CEST = 17:30 UTC)
  const timeFilter = day === '2026-06-04'
    ? `AND time(s.entry_time) >= '17:30:00'`
    : '';
  return db.prepare(`
    SELECT
      s.id,
      s.wallet_address,
      substr(s.wallet_address,1,6)||'...'||substr(s.wallet_address,-4) as wallet_masked,
      s.entry_time,
      s.exit_time,
      s.duration_minutes,
      s.counted_as_visit,
      COALESCE(m.level, 0) as level,
      COALESCE(m.level_name, 'Sin NFT') as level_name
    FROM sessions s
    LEFT JOIN (
      SELECT wallet_address, MAX(level) as level, MAX(level_name) as level_name
      FROM mints WHERE status='success' GROUP BY wallet_address
    ) m ON s.wallet_address = m.wallet_address
    WHERE date(s.entry_time) = ? ${timeFilter}
    ORDER BY s.entry_time DESC
  `).all(day);
}

function getSessionDates() {
  // Retorna únicamente las fechas registradas en la agenda de eventos activa (events table con active = 1)
  // y cuenta las visitas registradas para cada fecha del evento.
  return db.prepare(`
    SELECT
      d.day as day,
      COUNT(CASE
        WHEN s.entry_time IS NOT NULL
          AND NOT (d.day = '2026-06-04' AND time(s.entry_time) < '17:30:00')
        THEN 1
      END) as count
    FROM (
      SELECT event_date AS day FROM events WHERE active = 1
    ) d
    LEFT JOIN sessions s ON date(s.entry_time) = d.day
    GROUP BY d.day
    ORDER BY d.day DESC
    LIMIT 60
  `).all();
}

function createRedemption(walletAddress, code) {
  try {
    db.exec('BEGIN TRANSACTION');
    db.prepare(`
      INSERT INTO redemptions (wallet_address, code)
      VALUES (?, ?)
    `).run(walletAddress, code);

    db.prepare(`
      INSERT INTO points (wallet_address, points, reason)
      VALUES (?, -300, ?)
    `).run(walletAddress, `Canje Tapa Gratis (Código: ${code})`);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

function getRedemptions(walletAddress) {
  if (!walletAddress) return [];
  return db.prepare(`SELECT * FROM redemptions WHERE LOWER(wallet_address) = LOWER(?) ORDER BY created_at DESC`).all(walletAddress);
}

function getAllRedemptions() {
  return db.prepare(`SELECT * FROM redemptions ORDER BY created_at DESC`).all();
}

function collectRedemption(id, adminUser) {
  db.prepare(`
    UPDATE redemptions
    SET status = 'delivered', delivered_at = datetime('now'), delivered_by = ?
    WHERE id = ?
  `).run(adminUser || null, id);
}

function hasEventOnThursday() {
  const madridTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const targetThursday = new Date(madridTime);
  const day = madridTime.getDay();
  // Calculate days to next Thursday
  let daysToThursday = (4 - day + 7) % 7;
  if (daysToThursday === 0) daysToThursday = 7; // If today is Thursday, check next Thursday, or wait, we check on Wednesday, so tomorrow is Thursday (daysToThursday=1).
  
  targetThursday.setDate(madridTime.getDate() + daysToThursday);
  
  const yyyy = targetThursday.getFullYear();
  const mm = String(targetThursday.getMonth() + 1).padStart(2, '0');
  const dd = String(targetThursday.getDate()).padStart(2, '0');
  const targetDateStr = `${yyyy}-${mm}-${dd}`;
  
  const row = db.prepare(`SELECT id FROM events WHERE event_date = ? AND active = 1`).get(targetDateStr);
  return !!row;
}

module.exports = {
  hasEventOnThursday,
  openSession,
  closeSession,
  checkRecentVisit,
  db,
  insertMint,
  updateMintStatus,
  getStats,
  getHolders,
  getMultiLevelHolders,
  getWalletsByLevel,
  getClaimedLevels,
  insertMessage,
  getMessages,
  checkDuplicate,
  clearStaleMint,
  getPendingApprovalMints,
  approveMint,
  rejectMint,
  insertVisit,
  getVisitCount,
  getEligibleRaffleParticipants,
  autoCloseSessionsAt23,
  autoCloseSessionsAfterEvent,

  insertRaffle,
  collectRaffle,
  getRaffleHistory,
  getMyWins,
  getSessionAnalytics,
  getEventSessions,
  getSessionDates,
  createEvent,
  updateEvent,
  deleteEvent,
  getAllEvents,
  getEvents,
  toggleRsvp,
  getRsvpStatus,
  getRsvpsDetail,
  setRsvpAllergens,
  createVipReservation,
  getVipReservations,
  getVipReservation,
  getVipCapacity,
  setVipMax,
  updateVipStatus,
  savePushSubscription,
  getAllPushSubscriptions,
  deletePushSubscription,
  addReaction,
  getReactions,
  getReactionsForMessages,
  ALLOWED_REACTIONS,
  acceptRaffle,
  rejectRaffle,
  getRaffleParticipation,
  getRaffleById,
  getPrizePresets,
  addPrizePreset,
  deletePrizePreset,
  getRaffleCountTonight,
  getScheduledRaffles,
  createScheduledRaffle,
  updateScheduledRaffle,
  deleteScheduledRaffle,
  linkScheduledRaffle,
  getNextPendingMint,
  claimWeeklyRaffle,
  getWeeklyRaffleStatus,
  updateWeeklyPrize,
  drawWeeklyRaffle,
  collectWeeklyRaffle,
  collectWeeklyWinner,
  forfeitWeeklyRaffle,
  confirmWeeklyRaffle,
  forfeitExpiredWeeklyRaffles,
  getWeeklyRaffleTargetWeek,
  getActiveEventWindow,
  countPendingVisitsDuringEvent,
  WEEKLY_DEFAULT_RULES,
  getPartnerEstablishments,
  getVisiblePartnerEstablishments,
  upsertPartnerEstablishment,
  deletePartnerEstablishment
};

function claimWeeklyRaffle(walletAddress, weekStr) {
  db.prepare(`
    INSERT INTO weekly_claims (wallet_address, claimed_week)
    VALUES (?, ?)
  `).run(walletAddress, weekStr);
}

function getWeeklyRaffleStatus(walletAddress, weekStr) {
  if (!walletAddress) return { claimed: false, totalParticipants: 0, isConfigured: false };
  const raffle = db.prepare(`SELECT * FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
  
  const claim = db.prepare(`SELECT id FROM weekly_claims WHERE LOWER(wallet_address) = LOWER(?) AND claimed_week = ?`).get(walletAddress, weekStr);
  const totalParticipants = db.prepare(`SELECT COUNT(*) as count FROM weekly_claims WHERE claimed_week = ?`).get(weekStr)?.count || 0;

  let isWinner = false;
  let userCode = null;
  if (raffle && raffle.winner_wallet) {
    try {
      const wallets = JSON.parse(raffle.winner_wallet);
      const idx = wallets.findIndex(w => w.toLowerCase() === walletAddress.toLowerCase());
      if (idx !== -1) {
        isWinner = true;
        const codes = JSON.parse(raffle.verification_code || "{}");
        userCode = codes[wallets[idx]];
      }
    } catch (e) {
      // Fallback for old single string format
      isWinner = raffle.winner_wallet.toLowerCase() === walletAddress.toLowerCase();
      userCode = raffle.verification_code;
    }
  }

  // El código solo se revela al ganador una vez confirmado (o si es un sorteo
  // antiguo sin plazo de confirmación, o ya entregado)
  // Wait, if it's multiple winners, they ALL confirm at once? 
  // Currently, confirmed_at is just a global timestamp. 
  const codeUnlocked = raffle && (raffle.confirmed_at || raffle.collected_at || !raffle.confirm_deadline);

  return {
    claimed: !!claim,
    prize: raffle ? raffle.prize : null,
    rules: raffle ? (raffle.rules || WEEKLY_DEFAULT_RULES) : WEEKLY_DEFAULT_RULES,
    winnerWallet: raffle ? raffle.winner_wallet : null,
    // Solo el ganador ve su propio código — y solo tras confirmar
    verificationCode: isWinner && codeUnlocked ? (userCode || null) : null,
    status: raffle ? raffle.status : 'active',
    drawnAt: raffle ? raffle.drawn_at : null,
    collectedAt: raffle ? raffle.collected_at : null,
    forfeitedAt: raffle ? raffle.forfeited_at : null,
    confirmDeadline: raffle ? raffle.confirm_deadline : null,
    confirmedAt: raffle ? raffle.confirmed_at : null,
    totalParticipants,
    isConfigured: !!raffle
  };
}

function updateWeeklyPrize(weekStr, prize, rules, winnersCount = 1) {
  db.prepare(`INSERT OR IGNORE INTO weekly_raffles (claimed_week) VALUES (?)`).run(weekStr);
  db.prepare(`
    UPDATE weekly_raffles
    SET prize = ?, rules = ?, winners_count = ?
    WHERE claimed_week = ?
  `).run(prize, rules, winnersCount, weekStr);
}

function drawWeeklyRaffle(weekStr) {
  let raffle = db.prepare(`SELECT * FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
  if (!raffle) {
    db.prepare(`INSERT OR IGNORE INTO weekly_raffles (claimed_week) VALUES (?)`).run(weekStr);
    raffle = db.prepare(`SELECT * FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
  }

  if (raffle && raffle.status === 'completed') {
    throw new Error('El sorteo de esta semana ya ha sido realizado.');
  }

  const participants = db.prepare(`SELECT wallet_address FROM weekly_claims WHERE claimed_week = ?`).all(weekStr);
  if (!participants.length) {
    throw new Error('No hay participantes apuntados para esta semana.');
  }

  let winnersCount = raffle.winners_count || 1;
  const participantsList = participants.map(p => p.wallet_address);
  if (winnersCount > participantsList.length) winnersCount = participantsList.length;

  // Pick random winners
  const winnerWallets = [];
  const shuffled = participantsList.sort(() => 0.5 - Math.random());
  for (let i = 0; i < winnersCount; i++) {
    winnerWallets.push(shuffled[i]);
  }

  // Generar código de verificación tipo 'CHAVE-A3K9' para cada ganador
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const verificationCodes = {};
  for (const wallet of winnerWallets) {
    let code = 'CHAVE-';
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    verificationCodes[wallet] = code;
  }

  // Plazo de confirmación: esa misma noche a las 23:00 Madrid.
  // Si el sorteo se lanza ya pasadas las 22:30 (p. ej. tirada manual del admin), dar 2h de margen.
  const madridNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const todayMadridStr = `${madridNow.getFullYear()}-${String(madridNow.getMonth() + 1).padStart(2, '0')}-${String(madridNow.getDate()).padStart(2, '0')}`;
  let confirmDeadline = madridToUTC(todayMadridStr, '23:00');
  if (new Date(confirmDeadline.replace(' ', 'T') + 'Z').getTime() - Date.now() < 30 * 60000) {
    confirmDeadline = new Date(Date.now() + 2 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  }

  const winnerWalletStr = JSON.stringify(winnerWallets);
  const codeStr = JSON.stringify(verificationCodes);

  db.prepare(`
    UPDATE weekly_raffles
    SET winner_wallet = ?, drawn_at = datetime('now'), status = 'completed', verification_code = ?,
        confirm_deadline = ?, confirmed_at = NULL
    WHERE claimed_week = ?
  `).run(winnerWalletStr, codeStr, confirmDeadline, weekStr);

  return {
    winnerWallet: winnerWalletStr,
    prize: raffle.prize,
    verificationCode: codeStr,
    confirmDeadline
  };
}

// El ganador confirma que ha visto el premio (antes de las 23:00 de la noche del sorteo)
function confirmWeeklyRaffle(walletAddress, weekStr) {
  const raffle = db.prepare(`SELECT * FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
  if (!raffle) throw new Error('Sorteo no encontrado');
  let isWinner = false;
  if (raffle.winner_wallet) {
    try {
      const wallets = JSON.parse(raffle.winner_wallet);
      if (Array.isArray(wallets)) {
        isWinner = wallets.some(w => w.toLowerCase() === walletAddress.toLowerCase());
      } else {
        isWinner = wallets.toLowerCase() === walletAddress.toLowerCase();
      }
    } catch (e) {
      isWinner = raffle.winner_wallet.toLowerCase() === walletAddress.toLowerCase();
    }
  }
  if (!isWinner) {
    throw new Error('No eres el ganador de esta semana');
  }
  if (raffle.status === 'forfeited') throw new Error('El plazo de confirmación terminó y el premio se dio por perdido');
  if (raffle.status !== 'completed') throw new Error('El sorteo no está pendiente de confirmación');
  if (raffle.confirmed_at) return raffle; // idempotente — ya confirmado
  if (raffle.confirm_deadline) {
    const deadlineMs = new Date(raffle.confirm_deadline.replace(' ', 'T') + 'Z').getTime();
    if (Date.now() > deadlineMs) throw new Error('El plazo de confirmación ha terminado');
  }
  db.prepare(`UPDATE weekly_raffles SET confirmed_at = datetime('now') WHERE claimed_week = ?`).run(weekStr);
  return db.prepare(`SELECT * FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
}

// Da por perdidos los premios semanales cuyo plazo de confirmación expiró sin confirmar.
// Devuelve la lista de sorteos forfeit para poder notificar.
function forfeitExpiredWeeklyRaffles() {
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const expired = db.prepare(`
    SELECT claimed_week, prize, winner_wallet FROM weekly_raffles
    WHERE status = 'completed' AND confirmed_at IS NULL AND collected_at IS NULL
      AND confirm_deadline IS NOT NULL AND confirm_deadline <= ?
  `).all(nowStr);
  const stmt = db.prepare(`UPDATE weekly_raffles SET status = 'forfeited', forfeited_at = datetime('now') WHERE claimed_week = ?`);
  expired.forEach(r => stmt.run(r.claimed_week));
  return expired;
}

function collectWeeklyRaffle(weekStr) {
  const raffle = db.prepare(`SELECT winner_wallet FROM weekly_raffles WHERE claimed_week = ? AND status = 'completed'`).get(weekStr);
  if (!raffle) throw new Error('Sorteo no encontrado o no completado.');
  let collectedWallets = {};
  try {
    const wallets = JSON.parse(raffle.winner_wallet);
    const list = Array.isArray(wallets) ? wallets : [wallets];
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    list.forEach(w => { if (w) collectedWallets[w] = now; });
  } catch (_) {}
  const result = db.prepare(`
    UPDATE weekly_raffles
    SET collected_at = datetime('now'), collected_wallets = ?
    WHERE claimed_week = ? AND status = 'completed'
  `).run(JSON.stringify(collectedWallets), weekStr);
  if (!result.changes) throw new Error('Sorteo no encontrado o no completado.');
}

function collectWeeklyWinner(weekStr, walletAddress) {
  const raffle = db.prepare(`SELECT * FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
  if (!raffle || raffle.status !== 'completed') throw new Error('Sorteo no encontrado o no completado.');
  let winners = [];
  try {
    const parsed = JSON.parse(raffle.winner_wallet);
    winners = Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) { winners = [raffle.winner_wallet]; }
  const found = winners.find(w => w && w.toLowerCase() === walletAddress.toLowerCase());
  if (!found) throw new Error('Esta wallet no es ganadora de esta semana.');
  let collected = {};
  try { collected = JSON.parse(raffle.collected_wallets || '{}'); } catch (_) {}
  collected[found] = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const allCollected = winners.every(w => collected[w]);
  if (allCollected) {
    db.prepare(`UPDATE weekly_raffles SET collected_wallets = ?, collected_at = datetime('now') WHERE claimed_week = ?`).run(JSON.stringify(collected), weekStr);
  } else {
    db.prepare(`UPDATE weekly_raffles SET collected_wallets = ? WHERE claimed_week = ?`).run(JSON.stringify(collected), weekStr);
  }
  return { allCollected };
}

// Dar por perdido: el premio no se recogió a tiempo. Queda registrado (en la cuenta del ganador
// y en el historial admin) pero deja de aparecer como pendiente para el admin.
function forfeitWeeklyRaffle(weekStr) {
  const result = db.prepare(`
    UPDATE weekly_raffles
    SET forfeited_at = datetime('now'), status = 'forfeited'
    WHERE claimed_week = ? AND status = 'completed' AND collected_at IS NULL
  `).run(weekStr);
  if (!result.changes) throw new Error('Sorteo no encontrado, ya entregado o no completado.');
}

function getWeeklyRaffleTargetWeek(d = new Date()) {
  const madridTime = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const day = madridTime.getDay(); // 0=Dom..6=Sab
  const hour = madridTime.getHours();
  
  const targetThursday = new Date(madridTime);
  let daysToThursday = 0;
  
  if (day === 0) {
    if (hour >= 21) {
      daysToThursday = 4;
    } else {
      daysToThursday = 4; // Cambiado: El domingo por la mañana ya apunta al JUEVES SIGUIENTE
    }
  } else if (day === 1) {
    daysToThursday = 3;
  } else if (day === 2) {
    daysToThursday = 2;
  } else if (day === 3) {
    daysToThursday = 1;
  } else if (day === 4) {
    daysToThursday = 0;
  } else if (day === 5) {
    daysToThursday = 6; // Cambiado: El viernes ya apunta al JUEVES SIGUIENTE
  } else if (day === 6) {
    daysToThursday = 5; // Cambiado: El sábado ya apunta al JUEVES SIGUIENTE
  }
  
  targetThursday.setDate(madridTime.getDate() + daysToThursday);
  
  const tempDate = new Date(Date.UTC(targetThursday.getFullYear(), targetThursday.getMonth(), targetThursday.getDate()));
  tempDate.setUTCDate(tempDate.getUTCDate() + 4 - (tempDate.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tempDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tempDate - yearStart) / 86400000) + 1) / 7);
  return `${tempDate.getUTCFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
}

function getPartnerEstablishments() {
  return db.prepare(`SELECT * FROM partner_establishments ORDER BY name ASC`).all();
}

function getVisiblePartnerEstablishments() {
  return db.prepare(`SELECT * FROM partner_establishments WHERE visible = 1 ORDER BY name ASC`).all();
}

function upsertPartnerEstablishment({ id, name, mapsUrl, story, visible }) {
  if (id) {
    db.prepare(`
      UPDATE partner_establishments
      SET name = ?, maps_url = ?, story = ?, visible = ?
      WHERE id = ?
    `).run(name, mapsUrl || null, story || null, visible ? 1 : 0, id);
    return id;
  } else {
    const result = db.prepare(`
      INSERT INTO partner_establishments (name, maps_url, story, visible)
      VALUES (?, ?, ?, ?)
    `).run(name, mapsUrl || null, story || null, visible ? 1 : 0);
    return result.lastInsertRowid;
  }
}

function deletePartnerEstablishment(id) {
  db.prepare(`DELETE FROM partner_establishments WHERE id = ?`).run(id);
}

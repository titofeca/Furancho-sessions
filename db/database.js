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

// Directorio PERSISTENTE para imágenes subidas (logos de local, etc.). Vive junto
// a la BD, en el volumen de Railway, para que NO se borren en cada deploy (el disco
// de la app es efímero). En local cae junto al repo. Override con UPLOADS_DIR.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(dbDir, 'prize-images');
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (_) {}

console.log(`[DB] Base de datos en: ${DB_PATH}`);
const db = new DatabaseSync(DB_PATH);

// Activar WAL mode, foreign keys y busy_timeout para tolerar bloqueos en rolling deploy
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

try { db.exec(`CREATE TABLE IF NOT EXISTS prize_presets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`); } catch (_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS weekly_prize_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, emoji TEXT DEFAULT '🎁', label TEXT NOT NULL, prize TEXT NOT NULL, rules TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`); } catch (_) {}
try {
  const hasTemplates = db.prepare(`SELECT count(*) as c FROM weekly_prize_templates`).get().c;
  if (!hasTemplates) {
    const seed = db.prepare(`INSERT INTO weekly_prize_templates (emoji, label, prize, rules) VALUES (?, ?, ?, ?)`);
    seed.run('🪙', '200 Pesetas', '200 Pesetas (Vales Furancho)', '¡El clásico do furancho! Llévate 200 pesetas de las de antes para gastar en tazas de vino y raciones de la casa. ¡Auténtico sabor ochentero, ho!');
    seed.run('🎰', 'Doble Oportunidad', 'Doble Oportunidad en Sorteos', '¡Doble o nada, ho! Independientemente de tu nivel de furancheiro, esta semana tendrás el doble de oportunidades (doble papeleta en el bombo) en todos los sorteos en vivo en el local.');
    seed.run('🍷', 'Botella de Viño', 'Botella de Viño de la Casa', '¡Un clásico para llevar a casa o descorchar en la barra! Llévate una botella del mejor viño cosechero do furancho para brindar con quien tú quieras.');
    seed.run('🍳', 'Ración Especial', 'Ración Especial + Taza de Viño', '¡Un manjar furancheiro, ho! Llévate una ración especial de la casa (oreja, tortilla o jamón asado) y una taza de viño del patrón para empujar. ¡Comida de la hostia!');
    seed.run('🧺', 'Lote Furancheiro', 'Cesta de Productos do Furancho', '¡Lote completo, ho! Una cesta premium con productos típicos gallegos: viño casero, queso de tetilla, chorizo curado de aldea y pan de hogaza. ¡El paraíso del larpeiro!');
    seed.run('👕', 'Camiseta Oficial', 'Camiseta Oficial Furancho Sessions', '¡Viste con estilo furancheiro! Llévate la camiseta oficial de Furancho Sessions de edición limitada con diseño retro de los 80. ¡Serás el más pintón del barrio!');
    seed.run('☕', 'Licor Café', 'Botella de Licor Café Casero', '¡El elixir do furancheiro, ho! Una botella de licor café artesanal de receta secreta para espabilar el alma. Ideal para tomar bien frío después de un buen xantar. ¡Pura retranca líquida!');
    seed.run('🥧', 'Empanada Enteira', 'Empanada Gallega Entera', '¡Para compartir con la pandilla! Una empanada casera entera (de atún, carne o bacalao) hecha con la masa fina clásica gallega en horno de piedra. ¡La reina de cualquier furancho, ho!');
    seed.run('💑', 'Xantar para Dous', 'Cena para Dos Furancheiros', '¡Xantar completo para dos! Incluye una jarra de viño cosechero, dos raciones copiosas a elegir y postre de la casa. Para que presumas de invitación de la hostia con quien tú quieras.');
    seed.run('🎁', 'Sorpresa do Patrón', 'La Caja Sorpresa do Patrón', '¡Sorpresa sorpresa, ho! Una caja de madera misteriosa preparada a mano por el patrón del furancho con productos secretos que no te podemos desvelar... ¡Atrévete a descubrir lo que hay dentro!');
  }
} catch (_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS raffle_participants (raffle_id INTEGER NOT NULL, wallet_address TEXT NOT NULL, PRIMARY KEY (raffle_id, wallet_address))`); } catch (_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS scheduled_raffles (id INTEGER PRIMARY KEY AUTOINCREMENT, event_date TEXT NOT NULL, scheduled_time TEXT NOT NULL, prize TEXT NOT NULL, status TEXT DEFAULT 'pending', raffle_id INTEGER, target_level INTEGER, created_at TEXT DEFAULT (datetime('now')))`); } catch (_) {}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      level_filter TEXT DEFAULT 'all',
      rsvp_event_id INTEGER,
      action_type TEXT,
      send_at TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
} catch (_) {}

// Seed del primer mensaje programado para mañana (2026-06-21 11:00)
try {
  const count = db.prepare(`SELECT COUNT(*) as c FROM scheduled_messages`).get().c;
  if (count === 0) {
    db.prepare(`
      INSERT INTO scheduled_messages (subject, body, level_filter, send_at)
      VALUES (?, ?, ?, ?)
    `).run(
      "NFT Furancheiro Fiesteiro: ¡San Juan se acerca! 🔥",
      "¡Hola Furancheiros! Recordad que los que vengáis este Jueves 25 de Junio a la sesión de San Juan desbloquearéis el logro exclusivo 'Furancheiro Fiesteiro'. Este logro se podrá acuñar como un NFT y, ¡atención!, en las siguientes sesiones del furancho, poseer ciertos NFTs os dará privilegios y ventajas gastronómicas únicas en el local. ¡No os lo perdáis, nenos! 🍷🥓",
      "all",
      "2026-06-21 11:00"
    );
    console.log("[DB] Se ha programado el mensaje de San Juan para mañana a las 11:00.");
  }
} catch (_) {}
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
    CREATE TABLE IF NOT EXISTS daily_tapa_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      nft_type TEXT NOT NULL,
      nft_id TEXT NOT NULL,
      serial INTEGER NOT NULL DEFAULT 0,
      claim_date TEXT NOT NULL,
      claimed_at TEXT DEFAULT (datetime('now')),
      staff_user TEXT
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_claims_unique_nft ON daily_tapa_claims(nft_type, nft_id, serial, claim_date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_claims_wallet_date ON daily_tapa_claims(wallet_address, claim_date)`);
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
// Confirmación del ganador: tras el sorteo del miércoles 21:00 debe confirmar antes de las 23:59
try {
  db.exec(`ALTER TABLE weekly_raffles ADD COLUMN confirm_deadline TEXT`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE weekly_raffles ADD COLUMN confirmed_at TEXT`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE weekly_raffles ADD COLUMN collected_wallets TEXT DEFAULT NULL`);
} catch (_) {}
// Multi-ganador: confirmación y pérdida POR ganador (mapa {wallet: fecha}).
// `confirmed_at`/`forfeited_at` quedan como marcas agregadas (cuando TODOS confirman/pierden).
try { db.exec(`ALTER TABLE weekly_raffles ADD COLUMN confirmed_wallets TEXT DEFAULT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE weekly_raffles ADD COLUMN forfeited_wallets TEXT DEFAULT NULL`); } catch (_) {}
// Detalles/características del premio de la semana (editable por edición — el premio no
// siempre es el mismo). Distinto de `rules` (operativa del sorteo).
try {
  db.exec(`ALTER TABLE weekly_raffles ADD COLUMN prize_details TEXT DEFAULT NULL`);
} catch (_) {}
// Filtro de elegibilidad de La Chave: nivel mínimo y/o logro NFT requerido.
try { db.exec(`ALTER TABLE weekly_raffles ADD COLUMN min_level INTEGER DEFAULT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE weekly_raffles ADD COLUMN required_achievement TEXT DEFAULT NULL`); } catch (_) {}
// Premio en forma de NFT para la Chave Semanal. Si es null, el premio es físico
// (flujo de siempre con código/bono). Si tiene id, el ganador va al furancho y el
// camarero se lo entrega desde el escáner (encola achievement_mints pending_approval).
// nft_granted_wallets: mapa JSON { wallet: timestamp } de a quién ya se le entregó.
try { db.exec(`ALTER TABLE weekly_raffles ADD COLUMN nft_achievement_id TEXT DEFAULT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE weekly_raffles ADD COLUMN nft_granted_wallets TEXT DEFAULT NULL`); } catch (_) {}
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

// Mints de LOGROS (ediciones especiales NFT, token >= 100). Separado de `mints`, que
// está limitado a niveles 1-4 por CHECK. Un logro por wallet (UNIQUE).
try {
  db.exec(`CREATE TABLE IF NOT EXISTS achievement_mints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    achievement_id TEXT NOT NULL,
    token_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    tx_hash TEXT,
    cost_matic REAL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(wallet_address, achievement_id)
  )`);
} catch (_) {}

// Chat 1:1 entre el ganador de la Chave Semanal y el staff (admin). Hilo por wallet+semana.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS weekly_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claimed_week TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    sender TEXT NOT NULL CHECK(sender IN ('client','admin')),
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    read_by_admin INTEGER DEFAULT 0,
    read_by_client INTEGER DEFAULT 0
  )`);
} catch (_) {}

// Vistas del premio de la Chave Semanal (cuántos furancheiros distintos vieron el
// mensaje cada semana). Una fila por wallet+semana — visitas repetidas no duplican.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS weekly_message_views (
    wallet_address TEXT NOT NULL,
    claimed_week TEXT NOT NULL,
    viewed_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (wallet_address, claimed_week)
  )`);
} catch (_) {}

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
    action_type TEXT,
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

  CREATE TABLE IF NOT EXISTS client_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS board_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    display_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
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
// Asegurar que las wallets del Presidente/test tengan al menos 3 visitas registradas en sesiones de eventos pasados
try {
  const targets = ['0x5EFd6c904CfdB7029340E69B056364921B0eaBE1', '0x3bdE3779DB08057A372b36577A999c34A268C54D'];
  for (const target of targets) {
    // Comprobar cuántas visitas (sesiones con counted_as_visit = 1) tiene ya
    const currentCount = db.prepare(`
      SELECT COUNT(DISTINCT date(entry_time)) as count FROM sessions 
      WHERE LOWER(wallet_address) = LOWER(?) AND counted_as_visit = 1
    `).get(target).count;
    
    if (currentCount < 3) {
      // Si tiene menos de 3 visitas, buscamos sus sesiones y las ponemos a 1
      db.prepare(`
        UPDATE sessions SET counted_as_visit = 1 
        WHERE LOWER(wallet_address) = LOWER(?)
      `).run(target);
      
      // Si aún después de actualizar sigue teniendo menos de 3, creamos sesiones para eventos pasados
      const newCount = db.prepare(`
        SELECT COUNT(DISTINCT date(entry_time)) as count FROM sessions 
        WHERE LOWER(wallet_address) = LOWER(?) AND counted_as_visit = 1
      `).get(target).count;
      
      if (newCount < 3) {
        const pastDates = ['2026-06-04 20:00:00', '2026-06-11 20:00:00', '2026-06-18 20:00:00'];
        for (const dateStr of pastDates) {
          // Comprobar si ya existe una sesión ese día
          const day = dateStr.split(' ')[0];
          const exists = db.prepare(`
            SELECT id FROM sessions 
            WHERE LOWER(wallet_address) = LOWER(?) AND date(entry_time) = ?
          `).get(target, day);
          
          if (!exists) {
            db.prepare(`
              INSERT INTO sessions (wallet_address, entry_time, exit_time, duration_minutes, counted_as_visit) 
              VALUES (?, ?, ?, 60, 1)
            `).run(target, dateStr, dateStr.replace('20:00:00', '21:00:00'));
          }
        }
      }
      console.log(`[DB] Inicializadas/actualizadas visitas manuales para el Presidente (${target})`);
    }
  }
} catch (e) {
  console.warn('[DB] Error en migración manual del Presidente:', e.message);
}


try { db.exec(`ALTER TABLE events ADD COLUMN vip_max INTEGER DEFAULT 15`); } catch (_) {}
// Ventana horaria del evento (hora Madrid) — define cuándo un fichaje cuenta como elegible para sorteos en vivo
try { db.exec(`ALTER TABLE events ADD COLUMN start_time TEXT DEFAULT '19:00'`); } catch (_) {}
try { db.exec(`ALTER TABLE events ADD COLUMN end_time TEXT DEFAULT '23:59'`); } catch (_) {}
// Alias gracioso y anónimo de la reserva VIP (se genera al confirmar; hace de "nombre de la mesa")
try { db.exec(`ALTER TABLE vip_reservations ADD COLUMN alias TEXT`); } catch (_) {}
// ── FACTURACIÓN POR EVENTO (PRIVADO — solo panel admin) ──────────────────────
// Tabla SEPARADA a propósito: la tabla `events` la sirve getEvents() (público) con
// SELECT e.*, así que cualquier columna ahí se filtraría a los clientes. Al vivir
// aparte, ningún endpoint público la toca — el dinero solo se lee vía rutas admin.
// Importes en CÉNTIMOS de euro (enteros) para no arrastrar errores de coma flotante.
try { db.exec(`CREATE TABLE IF NOT EXISTS event_finances (
  event_id INTEGER PRIMARY KEY,
  revenue_cents INTEGER,
  covers INTEGER,
  tables_count INTEGER,
  vip_count INTEGER,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
)`); } catch (_) {}
// Costes por evento (misma tabla privada): para calcular beneficio y margen y ver
// qué eventos rentan más. En céntimos, como la facturación. "otros" lleva etiqueta.
try { db.exec(`ALTER TABLE event_finances ADD COLUMN cost_staff_cents INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE event_finances ADD COLUMN cost_dj_cents INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE event_finances ADD COLUMN cost_band_cents INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE event_finances ADD COLUMN cost_fnb_cents INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE event_finances ADD COLUMN cost_decor_cents INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE event_finances ADD COLUMN cost_other_cents INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE event_finances ADD COLUMN cost_other_label TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN collected INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN collected_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN collected_by TEXT`); } catch (_) {}

// ── INSTALACIONES DE LA APP (contador de "furancheiros con app") ─────────────
// Tabla TOTALMENTE AISLADA: registra la wallet cuando alguien crea/abre su cuenta,
// aunque nunca venga al local. NO la tocan la asistencia, los sorteos, los niveles
// ni ninguna métrica anterior — solo alimenta un contador propio para saber a
// cuánta gente le ha llegado la app. Idempotente por wallet (una fila por wallet).
try { db.exec(`CREATE TABLE IF NOT EXISTS app_installs (
  wallet_address TEXT PRIMARY KEY,
  first_seen TEXT DEFAULT (datetime('now'))
)`); } catch (_) {}

// Backfill automático e idempotente de instalaciones iniciales para que el admin vea los históricos
try {
  db.exec('BEGIN TRANSACTION');
  db.exec(`
    INSERT OR IGNORE INTO app_installs (wallet_address, first_seen)
    SELECT LOWER(wallet_address) as wallet, MIN(created_at) as first_seen FROM (
      SELECT wallet_address, minted_at as created_at FROM mints WHERE status != 'failed'
      UNION ALL
      SELECT wallet_address, entry_time as created_at FROM sessions WHERE counted_as_visit = 1
      UNION ALL
      SELECT wallet_address, visited_at as created_at FROM visits
    )
    WHERE wallet_address IS NOT NULL AND wallet_address != ''
    GROUP BY LOWER(wallet_address)
  `);
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch(_) {}
  console.error('[DB] Error al realizar backfill de app_installs:', e);
}
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
// Logro NFT requerido para participar en un sorteo nocturno (id del catálogo de logros).
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN required_achievement TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN participant_level INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN validity TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN people TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN hours TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN days TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN validity TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN people TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN hours TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN days TEXT`); } catch (_) {}
// Fecha límite de canje (YYYY-MM-DD). Pasada esa fecha, el botón de canje se desactiva.
try { db.exec(`ALTER TABLE raffles ADD COLUMN validity_end_date TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN validity_end_date TEXT`); } catch (_) {}
// Premio en forma de NFT (logro). Si es null, el sorteo es un premio físico normal
// (bono canjeable con código). Si tiene id, al ganar hay que ir al furancho y el
// camarero lo entrega desde el escáner del staff (encola achievement_mints pending_approval).
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN nft_achievement_id TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN nft_achievement_id TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN nft_granted_at TEXT`); } catch (_) {}
// Auto-lanzamiento por-sorteo (flag propio). El auto-launcher lanza cuando llega la
// hora si este flag O el master switch global (app_settings.raffle_auto_launch_all) está en 1.
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN auto_launch INTEGER DEFAULT 0`); } catch (_) {}
// Última hora (ISO) a la que el auto-launcher intentó lanzar este sorteo. Sirve
// para espaciar reintentos (p.ej. si aún no hay elegibles no se martillea cada 20s).
try { db.exec(`ALTER TABLE scheduled_raffles ADD COLUMN last_auto_attempt_at TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE raffles ADD COLUMN nft_granted_by TEXT`); } catch (_) {}
// Logros NFT creados desde el panel (se fusionan con los del código en services/achievements.js).
// NO toca los logros hardcodeados (token 100, etc.): esto es puramente aditivo.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS custom_achievements (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    image TEXT,
    token_id INTEGER UNIQUE,
    edition TEXT,
    rule_type TEXT DEFAULT 'visit_on_date',
    rule_date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
} catch (_) {}
// Campaña "Reto de los 5" (verano 2026): visitas de fidelización, independientes del
// fichaje normal y de los niveles. 1 visita por cliente por día natural (UNIQUE).
try {
  db.exec(`CREATE TABLE IF NOT EXISTS campaign_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    campaign_id TEXT NOT NULL DEFAULT 'reto_5_verano_2026',
    visit_date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(wallet_address, campaign_id, visit_date)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_campaign_visits_wallet ON campaign_visits(wallet_address)`);
} catch (_) {}
// Overrides puntuales de logros hardcodeados (p.ej. cambiar la imagen del NFT Legend
// desde el panel admin sin tocar código). Aplicados por services/achievements.js.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS achievement_overrides (
    achievement_id TEXT PRIMARY KEY,
    image TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
} catch (_) {}
// Ajustes generales del panel (key-value). Almacén genérico reutilizable.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
} catch (_) {}
// Banco do Corcho: saldos, transacciones en $CORCHO y registro de traspasos de NFTs
try {
  db.exec(`CREATE TABLE IF NOT EXISTS corcho_balances (
    wallet_address TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    total_earned INTEGER NOT NULL DEFAULT 0,
    total_spent INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS corcho_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    reference_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_corcho_tx_wallet ON corcho_transactions(wallet_address)`);
  db.exec(`CREATE TABLE IF NOT EXISTS nft_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nft_type TEXT,
    nft_id TEXT,
    from_wallet TEXT NOT NULL,
    to_wallet TEXT NOT NULL,
    fee_paid INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS corcho_items (

    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    emoji TEXT DEFAULT '🎁',
    price_corcho INTEGER NOT NULL,
    description TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  const itemCount = db.prepare(`SELECT COUNT(*) c FROM corcho_items`).get().c;
  if (itemCount === 0) {
    const insertItem = db.prepare(`INSERT INTO corcho_items (name, emoji, price_corcho, description) VALUES (?, ?, ?, ?)`);
    insertItem.run('1 Cunca do País', '🍷', 400, 'Consumición de 1 cunca de vino blanco o tinto do país');
    insertItem.run('1 Tapa Tradicional', '🧀', 700, 'Tapa tradicional de queso, embutido o empanada');
    insertItem.run('1 Ración Gourmet / Especial', '🍖', 1200, 'Ración especial de la casa');
    insertItem.run('Camiseta Oficial Furancho / Meme VIP', '👕', 4000, 'Camiseta o producto exclusivo oficial Furancho');
  }
} catch (_) {}


// Visibilidad POR LOGRO en el museo: qué NFT ven los clientes (sombreados) ANTES de

// conseguirlos. Se guardan aquí SOLO los que el admin ha decidido OCULTAR; por defecto
// (no está en la tabla) el logro se muestra. Aplica a logros del código y creados.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS achievement_hidden_locked (
    achievement_id TEXT PRIMARY KEY,
    hidden_at TEXT DEFAULT (datetime('now'))
  )`);
} catch (_) {}
// Cuentas regresivas dinámicas (admin crea/edita/borra; cliente las ve en la home).
try {
  db.exec(`CREATE TABLE IF NOT EXISTS countdowns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    subtitle TEXT,
    emoji TEXT DEFAULT '⏳',
    target_date TEXT NOT NULL,
    logo_path TEXT,
    theme TEXT DEFAULT 'light',
    end_message TEXT,
    hide_after_end INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
} catch (_) {}
// ─── TIENDA DEL MEME (token 50) ──────────────────────────────────────────────
// El Meme VIP es el ÚNICO NFT que se compra; el resto se gana. Tablas separadas
// de achievement_mints para no tocar nada de lo que ya funciona: achievement_mints
// sigue siendo "esta wallet tiene el meme" (UNIQUE wallet+logro, museo y cola de
// minteo intactos) y meme_units es el registro de UNIDADES vendidas (una wallet
// puede tener varias; el precio de cada nueva sube, ver services/memeShop.js).
//
// EL LÍMITE DE 300 ES IRREVERSIBLE: vive en el código (services/memeShop.js) y
// además lo blinda el trigger de aquí abajo, que aborta el INSERT 301 aunque
// alguien se salte el servicio. Ninguna pantalla del panel lo puede editar.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS meme_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial INTEGER NOT NULL UNIQUE,
    wallet_address TEXT NOT NULL,
    purchase_id INTEGER,
    achievement_mint_id INTEGER,
    source TEXT DEFAULT 'venta',
    price_cents INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    tx_hash TEXT,
    cost_matic REAL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
} catch (_) {}
// Blindaje del límite a nivel de base de datos. status='failed' no cuenta (ese mint
// se puede reintentar). Si alguien intenta la unidad 301, SQLite aborta.
try {
  db.exec(`DROP TRIGGER IF EXISTS meme_units_max_supply`);
  db.exec(`CREATE TRIGGER meme_units_max_supply BEFORE INSERT ON meme_units
    WHEN (SELECT COUNT(*) FROM meme_units WHERE status != 'failed') >= 300
    BEGIN
      SELECT RAISE(ABORT, 'MEME_SUPPLY_AGOTADO: solo existen 300 memes y ya no queda ninguno');
    END`);
} catch (_) {}
// Solicitudes de compra del cliente ("Comprar meme" en el museo). El pago es
// presencial: queda 'requested' hasta que el admin cobra y confirma la venta.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS meme_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    status TEXT DEFAULT 'requested',
    price_cents INTEGER DEFAULT 0,
    unit_index INTEGER DEFAULT 1,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  )`);
} catch (_) {}
// Catálogo editable de lo que INCLUYE el meme (admin: "1 camiseta, 3 tapas…").
// kind: 'consumible' (se gasta en el local) | 'entrega' (artículo físico, puede
// quedar pendiente de entrega si no hay stock).
try {
  db.exec(`CREATE TABLE IF NOT EXISTS meme_perks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emoji TEXT DEFAULT '🎁',
    label TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    kind TEXT DEFAULT 'consumible',
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
} catch (_) {}
// Lo que incluía el meme EN EL MOMENTO DE LA VENTA (foto fija). Cambiar el
// catálogo de arriba nunca altera lo ya vendido.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS meme_entitlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id INTEGER NOT NULL,
    wallet_address TEXT NOT NULL,
    emoji TEXT DEFAULT '🎁',
    label TEXT NOT NULL,
    kind TEXT DEFAULT 'consumible',
    qty_total INTEGER NOT NULL DEFAULT 1,
    qty_used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  )`);
} catch (_) {}
// Registro de cada entrega/consumo (auditoría y deshacer).
try {
  db.exec(`CREATE TABLE IF NOT EXISTS meme_entitlement_uses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entitlement_id INTEGER NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
} catch (_) {}
// Los memes que ya estaban entregados ANTES de la tienda (achievement_mints) se
// registran como unidades para que cuenten contra las 300. Idempotente.
try {
  const legacy = db.prepare(`SELECT id, wallet_address, status FROM achievement_mints
                             WHERE achievement_id = 'meme_vip' AND status != 'failed' ORDER BY id ASC`).all();
  const already = db.prepare(`SELECT COUNT(*) c FROM meme_units WHERE achievement_mint_id = ?`);
  const maxSerial = () => (db.prepare(`SELECT COALESCE(MAX(serial), 0) s FROM meme_units`).get().s || 0);
  const ins = db.prepare(`INSERT INTO meme_units (serial, wallet_address, achievement_mint_id, source, price_cents, status)
                          VALUES (?, ?, ?, 'historico', 0, ?)`);
  legacy.forEach(m => {
    if (already.get(m.id).c > 0) return;
    ins.run(maxSerial() + 1, m.wallet_address, m.id, m.status);
  });
} catch (_) {}

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
try { db.exec(`ALTER TABLE messages ADD COLUMN action_type TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE scheduled_messages ADD COLUMN action_type TEXT`); } catch (_) {}
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

// Tablas de referidos / Plan Amigo
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_wallet TEXT NOT NULL,
      referred_wallet TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_wallet);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_wallet);
  `);
} catch (e) {
  console.error('Error al crear tabla de referidos:', e.message);
}


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

// ── Mints de LOGROS (NFT de ediciones especiales, claim del cliente) ─────────
// Idempotente: si ya existe (UNIQUE wallet+logro), no duplica y devuelve el existente.
function claimAchievement(walletAddress, achievementId, tokenId, status = 'pending') {
  const info = db.prepare(`
    INSERT OR IGNORE INTO achievement_mints (wallet_address, achievement_id, token_id, status)
    VALUES (?, ?, ?, ?)
  `).run(walletAddress, achievementId, tokenId, status);
  return { created: info.changes > 0, row: getAchievementMint(walletAddress, achievementId) };
}

function getAchievementMint(walletAddress, achievementId) {
  return db.prepare(`SELECT * FROM achievement_mints WHERE LOWER(wallet_address) = LOWER(?) AND achievement_id = ?`).get(walletAddress, achievementId);
}

function getWalletAchievementMints(walletAddress) {
  return db.prepare(`
    WITH RankedMints AS (
      SELECT id, wallet_address, achievement_id, token_id, status, tx_hash, cost_matic, created_at,
             ROW_NUMBER() OVER (PARTITION BY achievement_id ORDER BY id ASC) as mint_serial
      FROM achievement_mints
      WHERE status != 'failed'
    )
    SELECT * FROM RankedMints WHERE LOWER(wallet_address) = LOWER(?)
  `).all(walletAddress);
}

function getNextPendingAchievementMint() {
  return db.prepare(`SELECT * FROM achievement_mints WHERE status = 'pending' ORDER BY id ASC LIMIT 1`).get();
}

function updateAchievementMintStatus(id, status, txHash = null, costMatic = null) {
  db.prepare(`UPDATE achievement_mints SET status = ?, tx_hash = COALESCE(?, tx_hash), cost_matic = COALESCE(?, cost_matic) WHERE id = ?`)
    .run(status, txHash, costMatic, id);
}

// Candidatos a BACKFILL on-chain: registros marcados 'success' pero que se mintearon en
// modo demo (txHash 'demo_' o nulo). Solo Nv3/Nv4 (Nv1/Nv2 son off-chain por diseño).
// NFTs Nv3/Nv4 que DEBERÍAN estar on-chain pero no constan con tx real: los de
// época demo (success sin tx) Y los que quedaron en 'failed' (p.ej. el RPC se
// saturó a mitad de mint). El backfill comprueba el saldo on-chain antes de
// regastar gas, así que incluir los fallidos es seguro (si ya están, los salta).
function getDemoLevelMints() {
  return db.prepare(`SELECT id, wallet_address, level, level_name FROM mints
    WHERE level >= 3 AND (
      (status = 'success' AND (crossmint_action_id IS NULL OR crossmint_action_id LIKE 'demo_%'))
      OR status = 'failed'
    )
    ORDER BY id ASC`).all();
}
function getDemoAchievementMints() {
  return db.prepare(`SELECT id, wallet_address, achievement_id, token_id FROM achievement_mints
    WHERE (status = 'success' AND (tx_hash IS NULL OR tx_hash LIKE 'demo_%'))
      OR status = 'failed'
    ORDER BY id ASC`).all();
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

  // Visitas/asistencias canónicas (motor de métricas) — única fuente de verdad.
  // Lazy-require para evitar el ciclo de carga con services/metrics.js.
  let canonVisits = totalVisits, canonVisitsByDay = visitsByDay, canonUnique = uniqueVisitors;
  try {
    const vs = require('../services/metrics').getVisitStats();
    canonVisits = vs.totalVisits;
    canonVisitsByDay = vs.visitsByDay;
    canonUnique = vs.uniqueVisitors;
  } catch (_) {}

  return { total: total.count, totalMints: total.count, realMints: realMintsCount, totalMintCost,
           byLevel, recent: recentWithCost, byDate,
           totalVisits: canonVisits, visitsByDay: canonVisitsByDay, uniqueVisitors: canonUnique,
           mintsByLevel, appInstalls: getAppInstallStats() };
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

// Wallets que tienen un logro NFT concreto (no fallido) — para filtrar anuncios.
function getWalletsByAchievement(achievementId) {
  if (!achievementId) return [];
  return db.prepare(`SELECT DISTINCT wallet_address FROM achievement_mints WHERE achievement_id = ? AND status != 'failed'`)
    .all(achievementId)
    .map(r => r.wallet_address);
}

function insertMessage({ subject, body, levelFilter, recipientCount, rsvpEventId = null, actionType = null }) {
  const stmt = db.prepare(`
    INSERT INTO messages (subject, body, level_filter, recipient_count, rsvp_event_id, action_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(subject, body, levelFilter, recipientCount, rsvpEventId, actionType).lastInsertRowid;
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

// ==================== CAMPAÑA "RETO DE LOS 5" ====================
// Registra 1 visita de campaña por cliente por día natural (Madrid). Idempotente:
// si ya fichó hoy, no crea otra. Devuelve si contó y el total acumulado.
function recordCampaignVisit(walletAddress, dateStr, campaignId = 'reto_5_verano_2026') {
  if (!walletAddress || !dateStr) return { counted: false, totalVisits: 0 };
  const info = db.prepare(`
    INSERT OR IGNORE INTO campaign_visits (wallet_address, campaign_id, visit_date)
    VALUES (?, ?, ?)
  `).run(walletAddress, campaignId, dateStr);
  const totalVisits = getCampaignVisitCount(walletAddress, campaignId);
  return { counted: info.changes > 0, totalVisits };
}

function getCampaignVisitCount(walletAddress, campaignId = 'reto_5_verano_2026') {
  if (!walletAddress) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM campaign_visits
    WHERE LOWER(wallet_address) = LOWER(?) AND campaign_id = ?
  `).get(walletAddress, campaignId);
  return row ? row.c : 0;
}

// Ranking de la campaña: wallets ordenadas por nº de visitas (desc), con su última visita.
function getCampaignLeaderboard(limit = 10, campaignId = 'reto_5_verano_2026') {
  return db.prepare(`
    SELECT wallet_address, COUNT(*) as visits, MAX(visit_date) as last_visit
    FROM campaign_visits
    WHERE campaign_id = ?
    GROUP BY LOWER(wallet_address)
    ORDER BY visits DESC, last_visit DESC
    LIMIT ?
  `).all(campaignId, limit);
}

// Nº de participantes y de completados (>= requiredVisits) de la campaña.
function getCampaignStats(requiredVisits = 5, campaignId = 'reto_5_verano_2026') {
  const participants = db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT LOWER(wallet_address) as w FROM campaign_visits WHERE campaign_id = ? GROUP BY LOWER(wallet_address)
    )
  `).get(campaignId).c;
  const completed = db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT LOWER(wallet_address) as w FROM campaign_visits WHERE campaign_id = ?
      GROUP BY LOWER(wallet_address) HAVING COUNT(*) >= ?
    )
  `).get(campaignId, requiredVisits).c;
  return { participants, completed };
}

// Aprobación de logros (achievement_mints) — espejo del flujo de mints de nivel.
// La cola on-chain solo procesa status='pending', así que 'pending_approval' queda
// retenido hasta que el admin lo apruebe (evita gastar gas sin confirmar).
function getPendingApprovalAchievements() {
  return db.prepare(`
    SELECT id, wallet_address, achievement_id, token_id, created_at
    FROM achievement_mints WHERE status = 'pending_approval'
    ORDER BY created_at ASC
  `).all();
}

function approveAchievementMint(id) {
  db.prepare(`UPDATE achievement_mints SET status = 'pending' WHERE id = ? AND status = 'pending_approval'`).run(id);
}

function rejectAchievementMint(id) {
  db.prepare(`UPDATE achievement_mints SET status = 'rejected_admin' WHERE id = ? AND status = 'pending_approval'`).run(id);
}

// Override de imagen para un logro hardcodeado (p. ej. subir la definitiva del NFT
// Legend sin editar código). Se aplica en services/achievements.js al leer el catálogo.
function setAchievementImageOverride(achievementId, imagePath) {
  db.prepare(`
    INSERT INTO achievement_overrides (achievement_id, image, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(achievement_id) DO UPDATE SET image = excluded.image, updated_at = excluded.updated_at
  `).run(achievementId, imagePath);
}

function getAchievementImageOverride(achievementId) {
  const row = db.prepare(`SELECT image FROM achievement_overrides WHERE achievement_id = ?`).get(achievementId);
  return row ? row.image : null;
}

function getAllAchievementOverrides() {
  const rows = db.prepare(`SELECT achievement_id, image FROM achievement_overrides`).all();
  const map = {};
  rows.forEach(r => { map[r.achievement_id] = r.image; });
  return map;
}

// Ajustes generales (key-value). getSetting devuelve el fallback si no existe.
function getSetting(key, fallback = null) {
  try {
    const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key);
    return row ? row.value : fallback;
  } catch (_) { return fallback; }
}
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value == null ? null : String(value));
}
// Helper booleano: guarda '1'/'0' y lee con default.
function getBoolSetting(key, fallback = true) {
  const v = getSetting(key, null);
  return v == null ? fallback : v === '1';
}

// ── Visibilidad por logro en el museo (qué NFT ven los clientes sin conseguirlos) ──
// Devuelve los IDs OCULTOS (los que NO deben verse hasta conseguirlos).
function getHiddenLockedAchievementIds() {
  try { return db.prepare(`SELECT achievement_id FROM achievement_hidden_locked`).all().map(r => r.achievement_id); }
  catch (_) { return []; }
}
// visible=true → se ve sombreado antes de conseguirlo (quita de ocultos).
// visible=false → oculto hasta que el cliente lo consiga (lo añade a ocultos).
function setAchievementLockedVisibility(achievementId, visible) {
  if (visible) db.prepare(`DELETE FROM achievement_hidden_locked WHERE achievement_id = ?`).run(achievementId);
  else db.prepare(`INSERT OR IGNORE INTO achievement_hidden_locked (achievement_id) VALUES (?)`).run(achievementId);
}


function openSession(walletAddress, evMismatch) {
  if (!walletAddress) return { opened: false, counted: false };
  const now = new Date();
  const madridTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const yyyy = madridTime.getFullYear();
  const mm = String(madridTime.getMonth() + 1).padStart(2, '0');
  const dd = String(madridTime.getDate()).padStart(2, '0');
  const todayMadrid = `${yyyy}-${mm}-${dd}`;

  const existing = db.prepare(`SELECT id, entry_time, counted_as_visit FROM sessions WHERE LOWER(wallet_address) = LOWER(?) AND exit_time IS NULL ORDER BY entry_time DESC LIMIT 1`).get(walletAddress);

  if (existing) {
    const entryMadrid = new Date(new Date(existing.entry_time.replace(' ', 'T') + 'Z').toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const ey = entryMadrid.getFullYear();
    const em = String(entryMadrid.getMonth() + 1).padStart(2, '0');
    const ed = String(entryMadrid.getDate()).padStart(2, '0');
    const entryMadridDate = `${ey}-${em}-${ed}`;

    if (entryMadridDate !== todayMadrid) {
      db.prepare(`UPDATE sessions SET exit_time = datetime('now'), duration_minutes = 60 WHERE id = ?`).run(existing.id);
      console.log(`[Session] Cerrada sesión huérfana de fecha anterior (${entryMadridDate}) para la wallet ${walletAddress}`);
    } else {
      return { opened: false, counted: !!existing.counted_as_visit, alreadyOpen: true };
    }
  }

  const win = getActiveEventWindow();
  const inEventWindow = !!win && win.nowMs >= (win.startMs - EVENT_EARLY_MARGIN_MS) && win.nowMs <= win.endMs;
  const alreadyVisitedThisWeek = checkRecentVisit(walletAddress, 168);

  // Anti-picaresca: si el QR lleva fecha y no coincide con el evento activo, no cuenta
  const countedAsVisit = (inEventWindow && !alreadyVisitedThisWeek && !evMismatch) ? 1 : 0;
  if (evMismatch) console.log(`[Session] QR de otro evento usado por ${walletAddress.slice(0,8)}… — fichaje sin visita`);

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

// ── FACTURACIÓN POR EVENTO (PRIVADO) ─────────────────────────────────────────
// Estas funciones SOLO se llaman desde rutas admin (requireAuth). Nunca desde
// getEvents() ni ningún endpoint público. Importes en céntimos (enteros).

// Upsert de la facturación y costes de un evento. Campos null = "sin dato" (no 0).
function setEventFinance(eventId, { revenueCents, covers, tables, vipCount, notes,
  costStaffCents, costDjCents, costBandCents, costFnbCents, costDecorCents, costOtherCents, costOtherLabel }) {
  const norm = (v) => (v === null || v === undefined || v === '' ? null : v);
  db.prepare(`
    INSERT INTO event_finances (event_id, revenue_cents, covers, tables_count, vip_count, notes,
      cost_staff_cents, cost_dj_cents, cost_band_cents, cost_fnb_cents, cost_decor_cents, cost_other_cents, cost_other_label, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(event_id) DO UPDATE SET
      revenue_cents     = excluded.revenue_cents,
      covers            = excluded.covers,
      tables_count      = excluded.tables_count,
      vip_count         = excluded.vip_count,
      notes             = excluded.notes,
      cost_staff_cents  = excluded.cost_staff_cents,
      cost_dj_cents     = excluded.cost_dj_cents,
      cost_band_cents   = excluded.cost_band_cents,
      cost_fnb_cents    = excluded.cost_fnb_cents,
      cost_decor_cents  = excluded.cost_decor_cents,
      cost_other_cents  = excluded.cost_other_cents,
      cost_other_label  = excluded.cost_other_label,
      updated_at        = datetime('now')
  `).run(eventId, norm(revenueCents), norm(covers), norm(tables), norm(vipCount), norm(notes),
    norm(costStaffCents), norm(costDjCents), norm(costBandCents), norm(costFnbCents), norm(costDecorCents), norm(costOtherCents), norm(costOtherLabel));
  return getEventFinance(eventId);
}

function getEventFinance(eventId) {
  return db.prepare(`SELECT * FROM event_finances WHERE event_id = ?`).get(eventId) || null;
}

// Resumen para el panel admin: una fila por evento CON datos de facturación, más
// los agregados (totales y medias) que alimentan las estadísticas y el gráfico.
function getEventFinancesSummary() {
  const rows = db.prepare(`
    SELECT e.id AS event_id, e.event_date, e.title,
           f.revenue_cents, f.covers, f.tables_count, f.vip_count, f.notes, f.updated_at,
           f.cost_staff_cents, f.cost_dj_cents, f.cost_band_cents, f.cost_fnb_cents,
           f.cost_decor_cents, f.cost_other_cents, f.cost_other_label
    FROM event_finances f
    JOIN events e ON e.id = f.event_id
    WHERE f.revenue_cents IS NOT NULL OR f.covers IS NOT NULL
       OR f.tables_count IS NOT NULL OR f.vip_count IS NOT NULL
       OR f.cost_staff_cents IS NOT NULL OR f.cost_dj_cents IS NOT NULL
       OR f.cost_band_cents IS NOT NULL OR f.cost_fnb_cents IS NOT NULL
       OR f.cost_decor_cents IS NOT NULL OR f.cost_other_cents IS NOT NULL
    ORDER BY e.event_date ASC
  `).all();

  const c2e = (c) => (c != null ? c / 100 : null); // céntimos → euros (null se respeta)
  let totalRevenue = 0, totalCovers = 0, totalTables = 0, totalVip = 0, revenueEvents = 0;
  let totalCosts = 0;
  const costTotalsByCat = { staff: 0, dj: 0, band: 0, fnb: 0, decor: 0, other: 0 };

  const events = rows.map(r => {
    const revenue = c2e(r.revenue_cents);
    const costs = {
      staff: c2e(r.cost_staff_cents), dj: c2e(r.cost_dj_cents), band: c2e(r.cost_band_cents),
      fnb: c2e(r.cost_fnb_cents), decor: c2e(r.cost_decor_cents), other: c2e(r.cost_other_cents),
      otherLabel: r.cost_other_label || null
    };
    const costVals = [costs.staff, costs.dj, costs.band, costs.fnb, costs.decor, costs.other].filter(v => v != null);
    // costsTotal null = "sin costes apuntados" (distinto de costes 0)
    const costsTotal = costVals.length ? costVals.reduce((a, b) => a + b, 0) : null;
    // Beneficio solo cuando hay facturación; sin costes apuntados se asume coste 0
    const profit = revenue != null ? revenue - (costsTotal || 0) : null;
    const marginPct = (profit != null && revenue > 0) ? (profit / revenue) * 100 : null;
    const avgTicket = (revenue != null && r.covers) ? revenue / r.covers : null;   // €/persona
    const perTable  = (revenue != null && r.tables_count) ? revenue / r.tables_count : null; // €/mesa
    const vipPct    = (r.vip_count != null && r.covers) ? (r.vip_count / r.covers) * 100 : null;

    if (revenue != null) { totalRevenue += revenue; revenueEvents++; }
    if (costsTotal != null) totalCosts += costsTotal;
    if (costs.staff) costTotalsByCat.staff += costs.staff;
    if (costs.dj)    costTotalsByCat.dj    += costs.dj;
    if (costs.band)  costTotalsByCat.band  += costs.band;
    if (costs.fnb)   costTotalsByCat.fnb   += costs.fnb;
    if (costs.decor) costTotalsByCat.decor += costs.decor;
    if (costs.other) costTotalsByCat.other += costs.other;
    if (r.covers)       totalCovers += r.covers;
    if (r.tables_count) totalTables += r.tables_count;
    if (r.vip_count)    totalVip += r.vip_count;

    return {
      eventId: r.event_id, date: r.event_date, title: r.title,
      revenue, covers: r.covers, tables: r.tables_count, vipCount: r.vip_count,
      avgTicket, perTable, vipPct,
      costs, costsTotal, profit, marginPct,
      notes: r.notes, updatedAt: r.updated_at
    };
  });

  const totalProfit = totalRevenue - totalCosts;
  return {
    events,
    totals: {
      revenue: totalRevenue,
      covers: totalCovers,
      tables: totalTables,
      vip: totalVip,
      revenueEvents,
      avgTicket: totalCovers ? totalRevenue / totalCovers : null,  // ticket medio global (€/persona)
      perTable: totalTables ? totalRevenue / totalTables : null,    // €/mesa medio global
      avgRevenuePerEvent: revenueEvents ? totalRevenue / revenueEvents : null,
      vipPct: totalCovers ? (totalVip / totalCovers) * 100 : null,
      costs: totalCosts,
      costsByCategory: costTotalsByCat,
      profit: totalProfit,
      marginPct: totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : null
    }
  };
}

// ── CUENTAS REGRESIVAS ────────────────────────────────────────────────────────
function getActiveCountdowns() {
  return db.prepare(`SELECT * FROM countdowns WHERE active = 1 ORDER BY sort_order ASC, target_date ASC`).all();
}
function getAllCountdowns() {
  return db.prepare(`SELECT * FROM countdowns ORDER BY sort_order ASC, target_date ASC`).all();
}
function getCountdown(id) {
  return db.prepare(`SELECT * FROM countdowns WHERE id = ?`).get(id) || null;
}
function createCountdown({ title, subtitle, emoji, target_date, logo_path, theme, end_message, hide_after_end, sort_order }) {
  const r = db.prepare(`INSERT INTO countdowns (title, subtitle, emoji, target_date, logo_path, theme, end_message, hide_after_end, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    title, subtitle || null, emoji || '⏳', target_date, logo_path || null,
    theme || 'light', end_message || null, hide_after_end != null ? (hide_after_end ? 1 : 0) : 1,
    sort_order || 0
  );
  return r.lastInsertRowid;
}
function updateCountdown(id, fields) {
  const allowed = ['title','subtitle','emoji','target_date','logo_path','theme','end_message','hide_after_end','active','sort_order'];
  const sets = []; const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(k === 'hide_after_end' || k === 'active' ? (fields[k] ? 1 : 0) : fields[k]);
    }
  }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE countdowns SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}
function deleteCountdown(id) {
  db.prepare(`DELETE FROM countdowns WHERE id = ?`).run(id);
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
  {
    date: '2026-07-09',
    title: 'Furancho Sessions — 9 Julio',
    description: 'Seguimos con el furancho en marcha. Aún no soltamos prenda, pero promete. Apúntate y lo ves, neno.'
  },
  {
    date: '2026-07-16',
    title: 'Furancho Sessions — 16 Julio',
    description: 'Otra noche de las buenas en camino. No adelantamos detalles todavía… reserva tu sitio y lo descubres.'
  },
  {
    date: '2026-07-23',
    title: 'Furancho Sessions — 23 Julio',
    description: 'Se viene noche de furancho. Mejor no contar mucho: ven y lo ves en directo, carallo.'
  },
  {
    date: '2026-07-30',
    title: 'Furancho Sessions — 30 Julio',
    description: 'Cerramos julio por todo lo alto. Lo que preparamos se disfruta mejor en persona. Apúntate.'
  },
];

// Fechas cuya descripción debe actualizarse aunque ya exista en BD (cuando cambias el texto desde aquí).
// Añade la fecha aquí cuando quieras forzar la actualización desde código.
const FORCED_UPDATE_DATES = [];

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

// ─── HIGIENE DE DATOS PARA MÉTRICAS (idempotente) ────────────────────────────
// Deja los datos limpios para que el motor de métricas (services/metrics.js) y
// los conteos de cliente sean consistentes. Idempotente: arregla también Railway.
//   1. Desactiva eventos de prueba que ensuciaban agendas y promedios.
//   2. Quita el flag de visita a sesiones de días SIN evento (taps de prueba).
//   3. Cierra sesiones "zombi" abiertas de días pasados que no son evento.
try {
  const EVENT_DATES_SQL = `SELECT event_date FROM events WHERE active = 1 AND title NOT LIKE '%est%'`;

  // 1) Eventos de prueba → inactivos
  const deact = db.prepare(`UPDATE events SET active = 0 WHERE active = 1 AND (title LIKE '%Test%' OR title LIKE '%test%')`).run();
  if (deact.changes > 0) console.log(`[DB] Higiene: ${deact.changes} evento(s) de prueba desactivado(s)`);

  // 2) Sesiones de días sin evento → counted_as_visit = 0 (no son asistencia real).
  //    Conservador: respeta la sesión si su fecha UTC o su fecha +2h coincide con un evento.
  const unvisit = db.prepare(`
    UPDATE sessions SET counted_as_visit = 0
    WHERE counted_as_visit = 1
      AND date(entry_time)            NOT IN (${EVENT_DATES_SQL})
      AND date(entry_time, '+2 hours') NOT IN (${EVENT_DATES_SQL})
  `).run();
  if (unvisit.changes > 0) console.log(`[DB] Higiene: ${unvisit.changes} sesión(es) de días sin evento desmarcadas como visita`);

  // 3) Sesiones zombi (abiertas, de hace >1 día, en día no-evento) → cerrar.
  const zombies = db.prepare(`
    UPDATE sessions
    SET exit_time = datetime(entry_time, '+60 minutes'), duration_minutes = 60, auto_closed = 1
    WHERE exit_time IS NULL
      AND entry_time < datetime('now', '-1 day')
      AND date(entry_time)            NOT IN (${EVENT_DATES_SQL})
      AND date(entry_time, '+2 hours') NOT IN (${EVENT_DATES_SQL})
  `).run();
  if (zombies.changes > 0) console.log(`[DB] Higiene: ${zombies.changes} sesión(es) zombi cerradas`);
} catch (e) {
  console.warn('[DB] Higiene de datos falló:', e.message);
}

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
  'A Cuadrilla', 'A Tropa', 'A Panda', 'A Troula', 'A Esmorga',
  'A Xuntanza', 'Os Larpeiros', 'Os Riquiños', 'Os Ghastas Pistas',
  'Os Trapalleiros', 'O Comando', 'Os Caralludos', 'A Irmandade',
  'Os Furancheiros', 'A Banda', 'Os Licorcafeteiros', 'O Consello',
  'A Mafía', 'Os Papaventos', 'Os Cunqueiros', 'Os Sanchos',
  'O Clan', 'Os Ratiños', 'Os Leriantes', 'Os Vellos Rockeiros',
  'Os Resacosos', 'Os Festixeiros', 'A Peña do Furancho', 'Os Cabaleiros',
  'O Bloque', 'Os Carcamáns', 'Os Alborotadores', 'A Xente Boa'
];
const VIP_ALIAS_COMPLEMENTOS = [
  'do Albariño', 'do Ribeiro', 'do Godello', 'do Mencía', 'do Polbo',
  'da Queimada', 'da Empanada', 'do Furancho', 'da Retranca', 'do Licor Café',
  'sen Filtro', 'das Cuncas Baleiras', 'da Verbena', 'do Recreo', 'da Leria',
  'do Ultramarinos', 'do Finisterre', 'da Costa da Morte', 'do Viño do Barril',
  'dos Ghaliñeiros', 'da Choiva', 'da Borraxeira', 'do Chiringuito', 'da Tasca',
  'do Millo', 'do Ghicho', 'da Terceira Idade', 'do Castro', 'do Milladoiro',
  'da Estrela', 'do Pemento de Herbón', 'da Dorna', 'da Ría de Arousa', 'do Canastro',
  'do Lume', 'da Foliada', 'da Rianxeira', 'do Sifón', 'do Raxo', 'do Churrasco'
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

function sendVipInboxNotification(walletAddress, eventId, status, alias) {
  try {
    const event = db.prepare(`SELECT title FROM events WHERE id=?`).get(eventId);
    const eventTitle = event ? event.title : 'Sesión Furancho';
    
    let subject = '';
    let body = '';
    
    if (status === 'pending') {
      subject = '⭐ Reserva VIP Solicitada';
      body = `Tu solicitud de mesa VIP para el evento "${eventTitle}" ha sido recibida y está pendiente de confirmación. Te avisaremos en cuanto el patrón la valide, ho. ⏳`;
    } else if (status === 'confirmed') {
      subject = '⭐ Reserva VIP Confirmada';
      body = `¡Buenas noticias, neno! Tu mesa VIP${alias ? ` a nombre de "${alias}"` : ''} para "${eventTitle}" ha sido confirmada. Al llegar, enseña tu perfil al staff para que te lleven a tu zona. 🥂`;
    } else if (status === 'cancelled') {
      subject = '❌ Reserva VIP Cancelada';
      body = `Lo sentimos, pero tu mesa VIP para "${eventTitle}" ha sido cancelada. Escríbenos si tienes cualquier duda.`;
    } else if (status === 'completed') {
      subject = '🎉 ¡Acceso VIP Validado!';
      body = `¡Bienvenido al furancho! Tu llegada ha sido registrada y tu mesa VIP "${alias || ''}" está lista. Esta visita ya suma para tu kilometraje y tus logros NFT. ¡Pásalo en grande, neno! 🍷`;
    }
    
    if (subject && body) {
      db.prepare(`
        INSERT INTO messages (subject, body, level_filter, recipient_count, rsvp_event_id, action_type)
        VALUES (?, ?, ?, 1, ?, 'vip')
      `).run(subject, body, walletAddress.toLowerCase(), eventId);
    }
  } catch (e) {
    console.error('Error inserting private VIP message:', e.message);
  }
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

  // Cifras canónicas (motor de métricas): gente dentro ahora y estancia media real.
  let canonActive = activeNow.count, canonAvg = avgGlobal.avg;
  try {
    const m = require('../services/metrics');
    canonActive = m.getActiveNow();
    const t = m.getTotalsDetail();
    if (t && t.avg_duration != null) canonAvg = t.avg_duration;
  } catch (_) {}

  return { avgByLevel, topClients, activeNow: canonActive, avgGlobal: canonAvg };
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

function insertRaffle(prize, winnerWallet, verificationCode, participantWallets = [], targetLevel = null, prizeDetails = null, prizeImage = null, establishment = null, type = 'night', hideName = 0, participantLevel = null, validity = null, people = null, hours = null, days = null, validityEndDate = null, nftAchievementId = null) {
  // Plazo de aceptación: 10s de animación + 600s de ventana de aceptación (debe coincidir
  // con acceptWindow en doLaunch — el sweeper de expiración usa este deadline)
  const deadline = new Date(Date.now() + 610000).toISOString().replace('T', ' ').slice(0, 19);
  const id = db.prepare(`
    INSERT INTO raffles (prize, winner_wallet, verification_code, status, acceptance_deadline, target_level, prize_details, prize_image, establishment, type, hide_name, participant_level, validity, people, hours, days, validity_end_date, nft_achievement_id)
    VALUES (?, ?, ?, 'pending_acceptance', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(prize, winnerWallet, verificationCode, deadline, targetLevel, prizeDetails, prizeImage, establishment, type, hideName ? 1 : 0, participantLevel || null, validity, people, hours, days, validityEndDate || null, nftAchievementId || null).lastInsertRowid;
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

// Canje del premio por el propio ganador (lo pulsa el staff del local en el móvil
// del cliente). Es idempotente y a prueba de doble canje: si ya está canjeado,
// devuelve el estado sin volver a marcarlo. Solo el ganador (misma wallet) puede
// cerrarlo, y solo si el premio fue aceptado antes.
function redeemRaffleByWinner(raffleId, walletAddress) {
  const raffle = db.prepare(`SELECT id, winner_wallet, status, prize, collected_at, validity_end_date, establishment FROM raffles WHERE id = ?`).get(raffleId);
  if (!raffle) throw new Error('Premio no encontrado');
  if (!raffle.winner_wallet || !walletAddress || raffle.winner_wallet.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error('No eres el ganador de este premio');
  }
  if (raffle.status === 'collected') {
    return { alreadyCollected: true, collected_at: raffle.collected_at, prize: raffle.prize, establishment: raffle.establishment };
  }
  if (raffle.status !== 'accepted') {
    throw new Error('Este premio no está listo para canjear');
  }
  if (raffle.validity_end_date) {
    const todayMadrid = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
    if (todayMadrid > raffle.validity_end_date) {
      throw new Error('Este premio ha caducado y ya no se puede canjear');
    }
  }
  const collectedBy = raffle.establishment
    ? `Canjeado en ${raffle.establishment}`
    : 'Canjeado en local (staff)';
  db.prepare(`
    UPDATE raffles SET collected = 1, status = 'collected', collected_at = datetime('now'), collected_by = ?
    WHERE id = ? AND status = 'accepted'
  `).run(collectedBy, raffleId);
  const updated = db.prepare(`SELECT collected_at, prize FROM raffles WHERE id = ?`).get(raffleId);
  return { alreadyCollected: false, collected_at: updated.collected_at, prize: updated.prize, establishment: raffle.establishment };
}

function getRaffleHistory() {
  return db.prepare(`
    SELECT id, prize,
           substr(winner_wallet,1,6)||'...'||substr(winner_wallet,-4) as wallet_masked,
           winner_wallet, verification_code, created_at,
           collected, collected_at, collected_by, status, rejection_note, accepted_at, target_level,
           prize_details, prize_image, establishment, type, hide_name,
           validity, people, hours, days, validity_end_date, nft_achievement_id, nft_granted_at
    FROM raffles
    ORDER BY created_at DESC LIMIT 100
  `).all();
}

function getMyWins(walletAddress) {
  if (!walletAddress) return [];
  return db.prepare(`
    SELECT id, prize, verification_code, created_at, collected, collected_at, status, target_level,
           prize_details, prize_image, establishment, validity, people, hours, days, nft_achievement_id, nft_granted_at
    FROM raffles WHERE LOWER(winner_wallet) = LOWER(?) AND status IN ('accepted','collected')
    ORDER BY created_at DESC LIMIT 20
  `).all(walletAddress);
}

// Premios NFT ganados por una wallet que aún no le fueron entregados presencialmente
// por el staff. Se usa en el escáner de camareros para mostrar el banner de "Otorgar NFT".
// Requisitos:
//  - wallet es el ganador
//  - el sorteo tiene nft_achievement_id (es un premio NFT, no físico)
//  - el ganador ya aceptó el premio (status='accepted') o al menos no lo rechazó
//  - no se otorgó todavía (nft_granted_at IS NULL)
function getPendingNftPrizes(walletAddress) {
  if (!walletAddress) return [];
  const lower = String(walletAddress).toLowerCase();

  // 1) Sorteos normales (tabla raffles): ganador único por fila.
  const raffleRows = db.prepare(`
    SELECT id, prize, nft_achievement_id, prize_image, created_at
    FROM raffles
    WHERE LOWER(winner_wallet) = LOWER(?)
      AND nft_achievement_id IS NOT NULL
      AND nft_granted_at IS NULL
      AND status IN ('accepted','collected','pending_acceptance')
    ORDER BY created_at DESC
  `).all(walletAddress).map(r => ({
    source: 'raffle', raffleId: r.id, week: null,
    prize: r.prize, nft_achievement_id: r.nft_achievement_id, prize_image: r.prize_image
  }));

  // 2) Chave Semanal (tabla weekly_raffles): winner_wallet es un array JSON de ganadores;
  //    nft_granted_wallets es un mapa JSON { wallet: ts } de a quién ya se le entregó.
  const weeklyRows = db.prepare(`
    SELECT claimed_week, prize, nft_achievement_id, winner_wallet, nft_granted_wallets, forfeited_wallets, drawn_at
    FROM weekly_raffles
    WHERE nft_achievement_id IS NOT NULL
      AND status = 'completed'
      AND winner_wallet IS NOT NULL
    ORDER BY drawn_at DESC
  `).all();
  const parseObj = (s) => { try { const o = JSON.parse(s || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (_) { return {}; } };
  const weeklyPending = [];
  for (const r of weeklyRows) {
    let winners = [];
    try { const p = JSON.parse(r.winner_wallet); winners = Array.isArray(p) ? p : [p]; }
    catch (_) { winners = r.winner_wallet ? [r.winner_wallet] : []; }
    const isWinner = winners.some(w => w && w.toLowerCase() === lower);
    if (!isWinner) continue;
    const granted = parseObj(r.nft_granted_wallets);
    const forfeited = parseObj(r.forfeited_wallets);
    // Ya entregado a esta wallet, o esta wallet perdió su plazo → no pendiente.
    const grantedKey = Object.keys(granted).find(k => k.toLowerCase() === lower);
    const forfeitedKey = Object.keys(forfeited).find(k => k.toLowerCase() === lower);
    if (grantedKey || forfeitedKey) continue;
    weeklyPending.push({
      source: 'weekly', raffleId: null, week: r.claimed_week,
      prize: r.prize, nft_achievement_id: r.nft_achievement_id, prize_image: null
    });
  }

  // 3) Logro Furancheiro de Honor por reservas VIP
  const honorPending = [];
  try {
    const achievements = require('../services/achievements');
    const honor = achievements.getById('furancheiro_honor');
    if (honor && achievements.walletUnlocked(walletAddress, honor)) {
      const existing = db.prepare(`SELECT * FROM achievement_mints WHERE LOWER(wallet_address) = LOWER(?) AND achievement_id = ?`).get(walletAddress, honor.id);
      if (!existing || existing.status === 'failed') {
        honorPending.push({
          source: 'honor', raffleId: null, week: null,
          prize: 'Insignia Furancheiro de Honor (Logro VIP)',
          nft_achievement_id: honor.id, prize_image: honor.image
        });
      }
    }
  } catch (err) {
    console.error('Error adding honor achievement to pending nft prizes:', err.message);
  }

  return [...raffleRows, ...weeklyPending, ...honorPending];
}

// Otorgamiento presencial del NFT al ganador desde el escáner del staff. Atómico:
//  - verifica ganador correcto
//  - verifica que aún no se otorgó (idempotente por raffleId)
//  - marca la fila con timestamp y quién lo otorgó
//  - encola achievement_mints en 'pending_approval' para que el admin confirme
// Devuelve { ok, error?, mintCreated }
// ¿Se agotó la tirada de este NFT? Solo aplica a los que tienen tirada limitada
// (el meme: 300 y ni uno más). Cuenta lo ya entregado, sin contar mints fallidos.
function _supplyAgotado(ach) {
  if (!ach || !ach.maxSupply) return false;
  const c = db.prepare(`SELECT COUNT(*) c FROM achievement_mints WHERE achievement_id = ? AND status != 'failed'`).get(ach.id).c || 0;
  return c >= ach.maxSupply;
}

function grantNftPrize(raffleId, walletAddress, grantedBy = 'staff') {
  const raffle = db.prepare(`
    SELECT id, winner_wallet, nft_achievement_id, nft_granted_at, status
    FROM raffles WHERE id = ?
  `).get(raffleId);
  if (!raffle) return { ok: false, error: 'raffle_not_found' };
  if (!raffle.nft_achievement_id) return { ok: false, error: 'not_an_nft_prize' };
  if (raffle.nft_granted_at) return { ok: false, error: 'already_granted' };
  if (!raffle.winner_wallet || raffle.winner_wallet.toLowerCase() !== String(walletAddress || '').toLowerCase()) {
    return { ok: false, error: 'wallet_mismatch' };
  }

  const achievements = require('../services/achievements');
  const ach = achievements.getById(raffle.nft_achievement_id);
  if (!ach) return { ok: false, error: 'achievement_not_found' };
  if (_supplyAgotado(ach)) return { ok: false, error: 'supply_agotado' };

  try {
    db.exec('BEGIN TRANSACTION');
    db.prepare(`UPDATE raffles SET nft_granted_at = datetime('now'), nft_granted_by = ? WHERE id = ?`).run(grantedBy, raffleId);
    // Entregar el NFT también cierra el bono del sorteo: es el mismo acto presencial
    // (el ganador recibe premio + NFT a la vez), así no queda "accepted" colgado.
    db.prepare(`
      UPDATE raffles SET collected = 1, status = 'collected', collected_at = datetime('now'), collected_by = ?
      WHERE id = ? AND status != 'collected'
    `).run(`NFT entregado (${grantedBy})`, raffleId);
    db.prepare(`
      INSERT OR IGNORE INTO achievement_mints (wallet_address, achievement_id, token_id, status)
      VALUES (?, ?, ?, 'pending_approval')
    `).run(walletAddress, ach.id, ach.tokenId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
  return { ok: true, mintCreated: true, achievement: { id: ach.id, name: ach.name, image: ach.image } };
}

// Otorgamiento presencial del NFT al ganador de la CHAVE SEMANAL. Igual que grantNftPrize
// pero para weekly_raffles (multi-ganador: marca solo a esta wallet en nft_granted_wallets).
function grantWeeklyNftPrize(weekStr, walletAddress, grantedBy = 'staff') {
  const raffle = db.prepare(`SELECT * FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
  if (!raffle) return { ok: false, error: 'raffle_not_found' };
  if (!raffle.nft_achievement_id) return { ok: false, error: 'not_an_nft_prize' };

  let winners = [];
  try { const p = JSON.parse(raffle.winner_wallet); winners = Array.isArray(p) ? p : [p]; }
  catch (_) { winners = raffle.winner_wallet ? [raffle.winner_wallet] : []; }
  const matched = winners.find(w => w && w.toLowerCase() === String(walletAddress || '').toLowerCase());
  if (!matched) return { ok: false, error: 'wallet_mismatch' };

  const parseObj = (s) => { try { const o = JSON.parse(s || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (_) { return {}; } };
  const granted = parseObj(raffle.nft_granted_wallets);
  if (Object.keys(granted).some(k => k.toLowerCase() === matched.toLowerCase())) {
    return { ok: false, error: 'already_granted' };
  }

  const achievements = require('../services/achievements');
  const ach = achievements.getById(raffle.nft_achievement_id);
  if (!ach) return { ok: false, error: 'achievement_not_found' };
  if (_supplyAgotado(ach)) return { ok: false, error: 'supply_agotado' };

  try {
    db.exec('BEGIN TRANSACTION');
    granted[matched] = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`UPDATE weekly_raffles SET nft_granted_wallets = ? WHERE claimed_week = ?`).run(JSON.stringify(granted), weekStr);
    db.prepare(`
      INSERT OR IGNORE INTO achievement_mints (wallet_address, achievement_id, token_id, status)
      VALUES (?, ?, ?, 'pending_approval')
    `).run(matched, ach.id, ach.tokenId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
  return { ok: true, mintCreated: true, achievement: { id: ach.id, name: ach.name, image: ach.image } };
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
           CASE WHEN LOWER(r.winner_wallet) = ? THEN r.establishment ELSE NULL END as establishment,
           CASE WHEN LOWER(r.winner_wallet) = ? THEN r.validity ELSE NULL END as validity,
           CASE WHEN LOWER(r.winner_wallet) = ? THEN r.people ELSE NULL END as people,
           CASE WHEN LOWER(r.winner_wallet) = ? THEN r.hours ELSE NULL END as hours,
           CASE WHEN LOWER(r.winner_wallet) = ? THEN r.days ELSE NULL END as days,
           CASE WHEN LOWER(r.winner_wallet) = ? THEN r.validity_end_date ELSE NULL END as validity_end_date,
           CASE WHEN LOWER(r.winner_wallet) = ? THEN r.nft_achievement_id ELSE NULL END as nft_achievement_id,
           CASE WHEN LOWER(r.winner_wallet) = ? THEN r.nft_granted_at ELSE NULL END as nft_granted_at
    FROM raffles r
    WHERE r.id IN (SELECT raffle_id FROM raffle_participants WHERE LOWER(wallet_address) = ?)
       OR LOWER(r.winner_wallet) = ?
    ORDER BY r.created_at DESC LIMIT 30
  `).all(lowerWallet, lowerWallet, lowerWallet, lowerWallet, lowerWallet, lowerWallet, lowerWallet, lowerWallet, lowerWallet, lowerWallet, lowerWallet, lowerWallet, lowerWallet, lowerWallet);
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

// ── Plantillas de premios de la Chave Semanal (CRUD) ──
function getWeeklyPrizeTemplates() {
  return db.prepare(`SELECT id, emoji, label, prize, rules FROM weekly_prize_templates ORDER BY id ASC`).all();
}
function addWeeklyPrizeTemplate({ emoji, label, prize, rules }) {
  return db.prepare(`INSERT INTO weekly_prize_templates (emoji, label, prize, rules) VALUES (?, ?, ?, ?)`).run(emoji || '🎁', label, prize, rules).lastInsertRowid;
}
function updateWeeklyPrizeTemplate(id, { emoji, label, prize, rules }) {
  return db.prepare(`UPDATE weekly_prize_templates SET emoji=coalesce(?,emoji), label=coalesce(?,label), prize=coalesce(?,prize), rules=coalesce(?,rules) WHERE id=?`)
    .run(emoji ?? null, label ?? null, prize ?? null, rules ?? null, id);
}
function deleteWeeklyPrizeTemplate(id) {
  db.prepare(`DELETE FROM weekly_prize_templates WHERE id = ?`).run(id);
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

function createScheduledRaffle({ eventDate, scheduledTime, prize, targetLevel, participantLevel, type, hideName, prizeDetails, prizeImage, establishment, requiredAchievement, validity, people, hours, days, validityEndDate, nftAchievementId }) {
  return db.prepare(`INSERT INTO scheduled_raffles (event_date, scheduled_time, prize, target_level, participant_level, type, hide_name, prize_details, prize_image, establishment, required_achievement, validity, people, hours, days, validity_end_date, nft_achievement_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventDate, scheduledTime, prize, targetLevel || null, participantLevel || null, type || 'night', hideName ? 1 : 0, prizeDetails || null, prizeImage || null, establishment || null, requiredAchievement || null, validity || null, people || null, hours || null, days || null, validityEndDate || null, nftAchievementId || null).lastInsertRowid;
}

function updateScheduledRaffle(id, { eventDate, scheduledTime, prize, status, targetLevel, participantLevel, type, hideName, prizeDetails, prizeImage, establishment, requiredAchievement, validity, people, hours, days, validityEndDate, nftAchievementId }) {
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
  if (requiredAchievement !== undefined) { fields.push('required_achievement = ?'); vals.push(requiredAchievement || null); }
  if (validity !== undefined)        { fields.push('validity = ?');          vals.push(validity); }
  if (people !== undefined)          { fields.push('people = ?');            vals.push(people); }
  if (hours !== undefined)           { fields.push('hours = ?');             vals.push(hours); }
  if (days !== undefined)            { fields.push('days = ?');              vals.push(days); }
  if (validityEndDate !== undefined) { fields.push('validity_end_date = ?'); vals.push(validityEndDate || null); }
  if (nftAchievementId !== undefined){ fields.push('nft_achievement_id = ?');vals.push(nftAchievementId || null); }
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

// FUENTE ÚNICA del registro del canje del privilexio (tapa do día). Valida el
// anti-doble-canje (1 por wallet y 1 por NFT+serie al día, y créditos Plan Amigo)
// y registra el canje. La usan el panel admin (Escáner) y el staff (/staff).
// Lanza Error con mensaje legible si el canje no procede.
function registerDailyTapaClaim({ walletAddress, nftType, nftId, serial, sig, staffUser }) {
  if (!walletAddress || !nftType || !nftId) throw new Error('Faltan parámetros');

  // Si viene firma (QR de la barra), la validamos criptográficamente.
  if (sig) {
    try {
      const { verifyMessage } = require('ethers');
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
      const msg = `tapa_claim:${walletAddress}:${nftType}:${nftId}:${serial}:${today}`;
      const recovered = verifyMessage(msg, sig);
      if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new Error('La firma del vale no coincide con la billetera del cliente.');
      }
    } catch (e) {
      throw new Error('Firma de vale no válida: ' + e.message);
    }
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  const finalSerial = parseInt(serial) || 0;

  // El privilexio se ACUMULA por NFT: una wallet con varios NFTs de la lista puede
  // canjear uno por cada NFT al día. Anti-trampas: el beneficio debe estar activo,
  // el NFT debe ser de la lista configurada, debe ser SUYO, y cada NFT concreto
  // (id + nº de serie) solo se usa una vez al día — aquí y en todo el sistema.
  const cfgGet = (k, f) => {
    try { const r = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(k); return r ? r.value : f; }
    catch (_) { return f; }
  };

  // 1. Beneficio activo (sin él no hay canje por ninguna vía)
  if (cfgGet('daily_tapa_enabled', '0') !== '1') {
    throw new Error('El privilexio de la tapa no está activo ahora mismo.');
  }

  if (nftType === 'achievement') {
    // 2a. Solo los NFTs que el admin ligó al privilexio dan derecho a tapa
    const allowedIds = String(cfgGet('daily_tapa_nft', 'guardian_furancho'))
      .split(',').map(s => s.trim()).filter(Boolean);
    if (!allowedIds.includes(String(nftId))) {
      throw new Error('Ese NFT no da derecho a este privilexio.');
    }
    // 2b. El NFT (id + nº de serie) tiene que pertenecer a ESTA billetera
    //     (mismo cálculo de nº de serie que el estado del privilexio)
    const owned = db.prepare(`
      WITH RankedMints AS (
        SELECT wallet_address, achievement_id,
               ROW_NUMBER() OVER (PARTITION BY achievement_id ORDER BY id ASC) as mint_serial
        FROM achievement_mints
        WHERE status = 'success'
      )
      SELECT 1 as ok FROM RankedMints
      WHERE LOWER(wallet_address) = LOWER(?) AND achievement_id = ? AND mint_serial = ?
    `).get(walletAddress, String(nftId), finalSerial);
    if (!owned) throw new Error('Ese NFT no pertenece a esta billetera.');
  } else if (nftType !== 'referral') {
    // Formatos antiguos ('level', 'chave'...): conservan la regla clásica de
    // 1 canje por wallet y día, que era la que los limitaba.
    const walletClaim = db.prepare(`
      SELECT id FROM daily_tapa_claims
      WHERE LOWER(wallet_address) = LOWER(?) AND claim_date = ?
    `).get(walletAddress, today);
    if (walletClaim) throw new Error('Esta billetera ya ha canjeado su tapa de hoy.');
  }

  // 3. Este NFT concreto (id + nº de serie) solo se usa una vez al día
  const nftClaim = db.prepare(`
    SELECT id FROM daily_tapa_claims
    WHERE nft_type = ? AND nft_id = ? AND serial = ? AND claim_date = ?
  `).get(nftType, nftId, finalSerial, today);
  if (nftClaim) throw new Error('Este NFT ya ha sido usado para un canje hoy.');

  // 4. Bono Plan Amigo: máximo 1 bono amigo al día (acumulable con los NFTs)
  //    y comprobar créditos disponibles (solo amigos nuevos y activos)
  if (nftType === 'referral') {
    const refToday = db.prepare(`
      SELECT id FROM daily_tapa_claims
      WHERE LOWER(wallet_address) = LOWER(?) AND nft_type = 'referral' AND claim_date = ?
    `).get(walletAddress, today);
    if (refToday) throw new Error('Ya canjeó su bono Plan Amigo de hoy.');

    const activeReferredFriendsRow = db.prepare(`
      SELECT COUNT(DISTINCT r.referred_wallet) as count
      FROM referrals r
      WHERE LOWER(r.referrer_wallet) = LOWER(?)
        AND (
          EXISTS (
            SELECT 1 FROM visits v
            WHERE LOWER(v.wallet_address) = LOWER(r.referred_wallet)
              AND v.visited_at >= r.created_at
          )
          OR EXISTS (
            SELECT 1 FROM sessions s
            WHERE LOWER(s.wallet_address) = LOWER(r.referred_wallet)
              AND s.counted_as_visit = 1
              AND s.entry_time >= r.created_at
          )
        )
    `).get(walletAddress);
    const activeReferredFriends = activeReferredFriendsRow ? activeReferredFriendsRow.count : 0;
    const referralCredits = Math.floor(activeReferredFriends / 15);
    const referralClaimsRow = db.prepare(`
      SELECT COUNT(*) as count FROM daily_tapa_claims
      WHERE LOWER(wallet_address) = LOWER(?) AND nft_type = 'referral'
    `).get(walletAddress);
    const referralClaims = referralClaimsRow ? referralClaimsRow.count : 0;
    if (referralClaims >= referralCredits) {
      throw new Error('No tienes bonos de recomendados disponibles para canjear.');
    }
  }

  // 5. Registrar el canje
  db.prepare(`
    INSERT INTO daily_tapa_claims (wallet_address, nft_type, nft_id, serial, claim_date, staff_user)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(walletAddress, nftType, nftId, finalSerial, today, staffUser || 'admin');
  return { success: true, claimDate: today };
}

// Marca este sorteo programado como "auto-lanzable": el auto-launcher lo dispara solo
// cuando llega su hora. No cambia el flujo del botón manual "▶ Lanzar" — sigue funcionando.
function setScheduledAutoLaunch(id, enabled) {
  db.prepare(`UPDATE scheduled_raffles SET auto_launch = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

// Registra que el auto-launcher intentó disparar este sorteo (aunque el intento haya
// fallado por "sin elegibles" — evita reintentar cada 20s).
function markScheduledAutoAttempt(id) {
  db.prepare(`UPDATE scheduled_raffles SET last_auto_attempt_at = datetime('now') WHERE id = ?`).run(id);
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
  // Fechas de la agenda activa con su nº de asistentes CANÓNICO (motor de métricas),
  // para que el desplegable "(N visitas)" coincida con la tarjeta de asistencia.
  try {
    const ov = require('../services/metrics').getOverview();
    return ov.perEvent
      .map(e => ({ day: e.event_date, count: e.attendees }))
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .slice(0, 60);
  } catch (_) {
    // Fallback al conteo bruto por si el motor fallara
    return db.prepare(`
      SELECT d.day as day,
        COUNT(CASE WHEN s.entry_time IS NOT NULL
          AND NOT (d.day = '2026-06-04' AND time(s.entry_time) < '17:30:00') THEN 1 END) as count
      FROM (SELECT event_date AS day FROM events WHERE active = 1) d
      LEFT JOIN sessions s ON date(s.entry_time) = d.day
      GROUP BY d.day ORDER BY d.day DESC LIMIT 60
    `).all();
  }
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

// ── INSTALACIONES DE LA APP ──────────────────────────────────────────────────
// Registra una wallet como "tiene la app" (idempotente). No escribe en ninguna
// otra tabla ni dispara nada de la operativa. Devuelve si era nueva.
function registerAppInstall(walletAddress) {
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) return { created: false };
  const info = db.prepare(`INSERT OR IGNORE INTO app_installs (wallet_address) VALUES (?)`)
    .run(walletAddress.toLowerCase());
  return { created: info.changes > 0 };
}

// Métrica del contador: total de instalaciones + cuántas han llegado a fichar
// alguna vez (conversión app→visita real). Cruza en LECTURA con sessions, sin
// tocarla. Todo derivado; no altera ninguna métrica existente.
function getAppInstallStats() {
  const total = db.prepare(`SELECT COUNT(*) c FROM app_installs`).get().c;
  const converted = db.prepare(`
    SELECT COUNT(*) c FROM app_installs a
    WHERE EXISTS (SELECT 1 FROM sessions s WHERE LOWER(s.wallet_address) = a.wallet_address)
  `).get().c;
  const last7 = db.prepare(`
    SELECT COUNT(*) c FROM app_installs
    WHERE first_seen >= datetime('now','-7 days')
  `).get().c;
  return {
    total,
    converted,                       // instalaciones que ya han fichado alguna vez
    only_app: total - converted,     // tienen la app pero aún no han venido
    conversion_pct: total ? Math.round(converted / total * 1000) / 10 : null,
    last_7d: last7
  };
}

module.exports = {
  UPLOADS_DIR,
  registerAppInstall,
  getAppInstallStats,
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
  getWalletsByAchievement,
  getClaimedLevels,
  insertMessage,
  getMessages,
  checkDuplicate,
  clearStaleMint,
  getPendingApprovalMints,
  approveMint,
  rejectMint,
  recordCampaignVisit,
  getCampaignVisitCount,
  getCampaignLeaderboard,
  getCampaignStats,
  getPendingApprovalAchievements,
  approveAchievementMint,
  rejectAchievementMint,
  setAchievementImageOverride,
  getAchievementImageOverride,
  getAllAchievementOverrides,
  getSetting,
  setSetting,
  getBoolSetting,
  getHiddenLockedAchievementIds,
  setAchievementLockedVisibility,
  getCorchoBalance,
  addCorchoCoins,
  spendCorchoCoins,
  getCorchoHistory,
  transferNftWithFee,

  getPendingNftPrizes,
  grantNftPrize,
  grantWeeklyNftPrize,
  insertVisit,
  getVisitCount,
  getEligibleRaffleParticipants,
  autoCloseSessionsAt23,
  autoCloseSessionsAfterEvent,

  insertRaffle,
  collectRaffle,
  redeemRaffleByWinner,
  getRaffleHistory,
  getMyWins,
  getSessionAnalytics,
  getEventSessions,
  getSessionDates,
  createEvent,
  updateEvent,
  setEventFinance,
  getEventFinance,
  getEventFinancesSummary,
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
  sendVipInboxNotification,
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
  getWeeklyPrizeTemplates,
  addWeeklyPrizeTemplate,
  updateWeeklyPrizeTemplate,
  deleteWeeklyPrizeTemplate,
  getRaffleCountTonight,
  getScheduledRaffles,
  createScheduledRaffle,
  setScheduledAutoLaunch,
  markScheduledAutoAttempt,
  registerDailyTapaClaim,
  updateScheduledRaffle,
  deleteScheduledRaffle,
  linkScheduledRaffle,
  getNextPendingMint,
  claimAchievement,
  getAchievementMint,
  getWalletAchievementMints,
  getNextPendingAchievementMint,
  updateAchievementMintStatus,
  getDemoLevelMints,
  getDemoAchievementMints,
  claimWeeklyRaffle,
  getWeeklyRaffleStatus,
  weeklyWinnerState,
  updateWeeklyPrize,
  drawWeeklyRaffle,
  collectWeeklyRaffle,
  collectWeeklyWinner,
  forfeitWeeklyRaffle,
  confirmWeeklyRaffle,
  forfeitExpiredWeeklyRaffles,
  insertWeeklyChatMessage,
  getWeeklyChatMessages,
  markWeeklyChatRead,
  getWeeklyChatThreads,
  recordWeeklyMessageView,
  getWeeklyMessageViewCount,
  getWeeklyMessageViewCounts,
  getWeeklyRaffleTargetWeek,
  isWeeklyWindowOpen,
  getActiveEventWindow,
  EVENT_EARLY_MARGIN_MS,
  countPendingVisitsDuringEvent,
  WEEKLY_DEFAULT_RULES,
  getPartnerEstablishments,
  getVisiblePartnerEstablishments,
  upsertPartnerEstablishment,
  deletePartnerEstablishment,
  getScheduledMessages,
  insertScheduledMessage,
  updateScheduledMessage,
  deleteScheduledMessage,
  getEventRecap,
  getActiveCountdowns,
  getAllCountdowns,
  getCountdown,
  createCountdown,
  updateCountdown,
  deleteCountdown,
  getCorchoItems,
  addCorchoItem,
  updateCorchoItem,
  deleteCorchoItem
};


function getEventRecap(eventDate) {
  const attendees = db.prepare(`
    SELECT COUNT(DISTINCT LOWER(wallet_address)) AS c
    FROM sessions WHERE date(entry_time) = ? AND counted_as_visit = 1
  `).get(eventDate)?.c || 0;

  const attendeeWallets = db.prepare(`
    SELECT DISTINCT LOWER(wallet_address) AS w
    FROM sessions WHERE date(entry_time) = ? AND counted_as_visit = 1
  `).all(eventDate).map(r => r.w);

  const prizes = db.prepare(`
    SELECT prize, establishment FROM raffles
    WHERE date(created_at) = ? AND status IN ('accepted','collected')
  `).all(eventDate);

  const levelUps = db.prepare(`
    SELECT COUNT(*) AS c FROM mints
    WHERE date(created_at) = ? AND status = 'success'
  `).get(eventDate)?.c || 0;

  const nftsMinted = db.prepare(`
    SELECT COUNT(*) AS c FROM achievement_mints
    WHERE date(created_at) = ? AND status IN ('success','pending')
  `).get(eventDate)?.c || 0;

  return { attendees, attendeeWallets, prizes, levelUps, nftsMinted };
}

function claimWeeklyRaffle(walletAddress, weekStr) {
  db.prepare(`
    INSERT INTO weekly_claims (wallet_address, claimed_week)
    VALUES (?, ?)
  `).run(walletAddress, weekStr);
}

// Ventana en la que La Chave es visible/participable: domingo 21:00 → miércoles 21:00
// (hora Madrid). ÚNICA fuente de la regla — la usan el claim, la visibilidad del premio
// y el cliente. El premio "se publica" solo (auto) al abrirse esta ventana el domingo.
function isWeeklyWindowOpen(d = new Date()) {
  const madrid = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const day = madrid.getDay(); // 0=Dom..6=Sab
  const hours = madrid.getHours();
  if (day === 1 || day === 2) return true;       // lun, mar
  if (day === 0) return hours >= 21;             // dom desde las 21:00
  if (day === 3) return hours < 21;              // mié hasta las 21:00
  return false;                                  // jue–sáb: cerrado
}

// Estado POR-GANADOR de un sorteo semanal (soporta multi-ganador). Devuelve los timestamps
// de confirmación/entrega/pérdida de ESA wallet. Compatible hacia atrás: si no hay mapas
// por-ganador (sorteos antiguos) cae a las marcas globales confirmed_at/collected_at/forfeited_at.
function weeklyWinnerState(raffle, walletAddress) {
  const empty = { confirmedAt: null, collectedAt: null, forfeitedAt: null, matchedWallet: null };
  if (!raffle || !walletAddress || !raffle.winner_wallet) return empty;
  let winners = [];
  try { const p = JSON.parse(raffle.winner_wallet); winners = Array.isArray(p) ? p : [p]; }
  catch (_) { winners = [raffle.winner_wallet]; }
  const matched = winners.find(w => w && w.toLowerCase() === walletAddress.toLowerCase());
  if (!matched) return empty;

  const parse = (s) => { try { const o = JSON.parse(s || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (_) { return {}; } };
  const conf = parse(raffle.confirmed_wallets);
  const coll = parse(raffle.collected_wallets);
  const forf = parse(raffle.forfeited_wallets);

  const confirmedAt = conf[matched] || (Object.keys(conf).length === 0 && raffle.confirmed_at ? raffle.confirmed_at : null);
  const collectedAt = coll[matched] || (Object.keys(coll).length === 0 && raffle.collected_at ? raffle.collected_at : null);
  const forfeitedAt = forf[matched] || (Object.keys(forf).length === 0 && raffle.status === 'forfeited' ? (raffle.forfeited_at || raffle.drawn_at) : null);

  return { confirmedAt, collectedAt, forfeitedAt, matchedWallet: matched };
}

function getWeeklyRaffleStatus(walletAddress, weekStr) {
  if (!walletAddress) return { claimed: false, isConfigured: false };
  const raffle = db.prepare(`SELECT * FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
  
  const claim = db.prepare(`SELECT id FROM weekly_claims WHERE LOWER(wallet_address) = LOWER(?) AND claimed_week = ?`).get(walletAddress, weekStr);

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

  // Estado POR-GANADOR (multi-ganador): cada ganador confirma/recoge/pierde el suyo.
  const myState = weeklyWinnerState(raffle, walletAddress);
  // El código solo se revela a ESTE ganador si confirmó (o ya lo recogió, o es un
  // sorteo antiguo sin plazo de confirmación).
  const codeUnlocked = !!(raffle && (myState.confirmedAt || myState.collectedAt || !raffle.confirm_deadline));

  // Visibilidad del premio: solo se revela a los clientes cuando se abre el bombo
  // (domingo 21:00) o una vez sorteado. Antes de eso el servidor NO devuelve el premio
  // (se enmascara), para que no se filtre llamando al endpoint fuera de ventana.
  const drawn = !!(raffle && raffle.status && raffle.status !== 'active');
  const prizeVisible = !!raffle && (drawn || isWeeklyWindowOpen());

  // Métrica: cuántos furancheiros distintos han visto el premio de esta semana
  // (una vez por wallet+semana). Solo cuenta cuando el premio realmente se reveló.
  if (prizeVisible) recordWeeklyMessageView(walletAddress, weekStr);

  return {
    claimed: !!claim,
    prizeVisible,
    minLevel: raffle ? (raffle.min_level || null) : null,
    requiredAchievement: raffle ? (raffle.required_achievement || null) : null,
    prize: prizeVisible ? raffle.prize : null,
    prizeDetails: prizeVisible ? (raffle.prize_details || null) : null,
    rules: prizeVisible ? (raffle.rules || WEEKLY_DEFAULT_RULES) : null,
    winnerWallet: raffle ? raffle.winner_wallet : null,
    // Solo el ganador ve su propio código — y solo tras confirmar
    verificationCode: isWinner && codeUnlocked ? (userCode || null) : null,
    status: raffle ? raffle.status : 'active',
    drawnAt: raffle ? raffle.drawn_at : null,
    // Por-ganador (no globales): así cada ganador ve SU estado independiente.
    collectedAt: myState.collectedAt,
    forfeitedAt: myState.forfeitedAt,
    confirmDeadline: raffle ? raffle.confirm_deadline : null,
    confirmedAt: myState.confirmedAt,
    isConfigured: !!raffle,
    // Premio NFT (chave dourada, etc.): si está, el ganador va al furancho y el
    // camarero se lo entrega. nftGranted = ya se le entregó a esta wallet.
    nftAchievementId: (prizeVisible && raffle) ? (raffle.nft_achievement_id || null) : null,
    nftGranted: (() => {
      if (!raffle || !raffle.nft_achievement_id) return false;
      try {
        const g = JSON.parse(raffle.nft_granted_wallets || '{}');
        return Object.keys(g).some(k => k.toLowerCase() === String(walletAddress).toLowerCase());
      } catch (_) { return false; }
    })()
  };
}

function updateWeeklyPrize(weekStr, prize, rules, winnersCount = 1, prizeDetails = null, minLevel = null, requiredAchievement = null, nftAchievementId = null) {
  db.prepare(`INSERT OR IGNORE INTO weekly_raffles (claimed_week) VALUES (?)`).run(weekStr);
  db.prepare(`
    UPDATE weekly_raffles
    SET prize = ?, rules = ?, winners_count = ?, prize_details = ?, min_level = ?, required_achievement = ?, nft_achievement_id = ?
    WHERE claimed_week = ?
  `).run(prize, rules, winnersCount, prizeDetails, minLevel || null, requiredAchievement || null, nftAchievementId || null, weekStr);
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

  // Sorteo PONDERADO: quien ha venido al local (tiene fichaje o pase) pesa más que
  // quien solo tiene la app. El peso del visitante es configurable (chave_visitor_weight,
  // por defecto 5); el de solo-app es 1. Si nadie es "solo-app" (lo normal cuando la
  // política está apagada), todos pesan igual → sorteo uniforme de siempre.
  const visitorWeight = Math.max(1, parseInt(getSetting('chave_visitor_weight', '5')) || 5);
  const lowered = participantsList.map(w => String(w).toLowerCase());
  const visitorSet = new Set();
  if (lowered.length) {
    const ph = lowered.map(() => '?').join(',');
    db.prepare(`SELECT DISTINCT LOWER(wallet_address) w FROM sessions WHERE LOWER(wallet_address) IN (${ph})`).all(...lowered).forEach(r => visitorSet.add(r.w));
    db.prepare(`SELECT DISTINCT LOWER(wallet_address) w FROM mints WHERE status != 'failed' AND LOWER(wallet_address) IN (${ph})`).all(...lowered).forEach(r => visitorSet.add(r.w));
  }
  const weightOf = (wallet) => (visitorSet.has(String(wallet).toLowerCase()) ? visitorWeight : 1);

  // Selección ponderada SIN reemplazo (cada ganador es distinto).
  const winnerWallets = [];
  const pool = participantsList.slice();
  for (let n = 0; n < winnersCount && pool.length; n++) {
    let total = 0;
    for (const w of pool) total += weightOf(w);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) { r -= weightOf(pool[idx]); if (r <= 0) break; }
    if (idx >= pool.length) idx = pool.length - 1;
    winnerWallets.push(pool[idx]);
    pool.splice(idx, 1);
  }

  // Generar código de verificación tipo 'CHAVE-A3K9' para cada ganador
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const verificationCodes = {};
  for (const wallet of winnerWallets) {
    let code = 'CHAVE-';
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    verificationCodes[wallet] = code;
  }

  // Plazo de confirmación: esa misma noche a las 23:59 Madrid.
  // Si el sorteo se lanza ya pasadas las 23:00 (p. ej. tirada manual del admin), dar 2h de margen.
  const madridNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const todayMadridStr = `${madridNow.getFullYear()}-${String(madridNow.getMonth() + 1).padStart(2, '0')}-${String(madridNow.getDate()).padStart(2, '0')}`;
  let confirmDeadline = madridToUTC(todayMadridStr, '23:59');
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

// El ganador confirma que ha visto el premio (antes de las 23:59 de la noche del sorteo).
// Multi-ganador: cada ganador confirma SOLO el suyo (mapa confirmed_wallets). El estado
// global confirmed_at se fija solo cuando TODOS los ganadores han confirmado.
function confirmWeeklyRaffle(walletAddress, weekStr) {
  const raffle = db.prepare(`SELECT * FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
  if (!raffle) throw new Error('Sorteo no encontrado');

  let winners = [];
  try { const p = JSON.parse(raffle.winner_wallet); winners = Array.isArray(p) ? p : [p]; }
  catch (_) { winners = raffle.winner_wallet ? [raffle.winner_wallet] : []; }
  const matched = winners.find(w => w && w.toLowerCase() === walletAddress.toLowerCase());
  if (!matched) throw new Error('No eres el ganador de esta semana');

  if (raffle.status === 'forfeited') throw new Error('El plazo de confirmación terminó y el premio se dio por perdido');
  if (raffle.status !== 'completed') throw new Error('El sorteo no está pendiente de confirmación');

  const parse = (s) => { try { const o = JSON.parse(s || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (_) { return {}; } };
  const confirmed = parse(raffle.confirmed_wallets);
  const forfeited = parse(raffle.forfeited_wallets);

  // Idempotente: este ganador ya confirmó (o sorteo antiguo confirmado globalmente).
  if (confirmed[matched]) return raffle;
  if (Object.keys(confirmed).length === 0 && raffle.confirmed_at) return raffle;
  // Este ganador ya perdió su plazo individualmente.
  if (forfeited[matched]) throw new Error('El plazo de confirmación terminó y tu premio se dio por perdido');
  // Plazo (compartido: todos se sortean a la vez).
  if (raffle.confirm_deadline) {
    const deadlineMs = new Date(raffle.confirm_deadline.replace(' ', 'T') + 'Z').getTime();
    if (Date.now() > deadlineMs) throw new Error('El plazo de confirmación ha terminado');
  }

  confirmed[matched] = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const allConfirmed = winners.every(w => confirmed[w]);
  if (allConfirmed) {
    db.prepare(`UPDATE weekly_raffles SET confirmed_wallets = ?, confirmed_at = datetime('now') WHERE claimed_week = ?`).run(JSON.stringify(confirmed), weekStr);
  } else {
    db.prepare(`UPDATE weekly_raffles SET confirmed_wallets = ? WHERE claimed_week = ?`).run(JSON.stringify(confirmed), weekStr);
  }
  return db.prepare(`SELECT * FROM weekly_raffles WHERE claimed_week = ?`).get(weekStr);
}

// Da por perdidos los premios semanales cuyo plazo de confirmación expiró sin confirmar.
// Multi-ganador: marca SOLO a los ganadores que no confirmaron (ni recogieron). El sorteo
// pasa a 'forfeited' únicamente si TODOS pierden; si alguno confirmó, sigue 'completed'.
// Devuelve [{ claimed_week, prize, wallets: [...] }] con los ganadores recién perdidos
// (solo los nuevos), para notificar a cada uno sin duplicar.
function forfeitExpiredWeeklyRaffles() {
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const candidates = db.prepare(`
    SELECT claimed_week, prize, winner_wallet, confirmed_wallets, collected_wallets, forfeited_wallets, confirmed_at, collected_at
    FROM weekly_raffles
    WHERE status = 'completed' AND confirm_deadline IS NOT NULL AND confirm_deadline <= ?
  `).all(nowStr);

  const parse = (s) => { try { const o = JSON.parse(s || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (_) { return {}; } };
  const newlyForfeited = [];

  candidates.forEach(r => {
    let winners = [];
    try { const p = JSON.parse(r.winner_wallet); winners = Array.isArray(p) ? p : [p]; }
    catch (_) { winners = r.winner_wallet ? [r.winner_wallet] : []; }
    if (!winners.length) return;

    const confirmed = parse(r.confirmed_wallets);
    const collected = parse(r.collected_wallets);
    const forfeited = parse(r.forfeited_wallets);
    // Compat: marcas globales antiguas valen para todos los ganadores.
    if (Object.keys(confirmed).length === 0 && r.confirmed_at) winners.forEach(w => { if (w) confirmed[w] = r.confirmed_at; });
    if (Object.keys(collected).length === 0 && r.collected_at) winners.forEach(w => { if (w) collected[w] = r.collected_at; });

    const justForfeited = [];
    winners.forEach(w => {
      if (!w || confirmed[w] || collected[w] || forfeited[w]) return; // ya resuelto
      forfeited[w] = nowStr;
      justForfeited.push(w);
    });
    if (justForfeited.length === 0) return;

    const allLost = winners.every(w => forfeited[w] && !confirmed[w] && !collected[w]);
    if (allLost) {
      db.prepare(`UPDATE weekly_raffles SET forfeited_wallets = ?, status = 'forfeited', forfeited_at = datetime('now') WHERE claimed_week = ?`).run(JSON.stringify(forfeited), r.claimed_week);
    } else {
      db.prepare(`UPDATE weekly_raffles SET forfeited_wallets = ? WHERE claimed_week = ?`).run(JSON.stringify(forfeited), r.claimed_week);
    }
    newlyForfeited.push({ claimed_week: r.claimed_week, prize: r.prize, wallets: justForfeited });
  });

  return newlyForfeited;
}

// Chat 1:1 entre el ganador de la Chave Semanal y el staff. Hilo identificado por wallet+semana.
function insertWeeklyChatMessage({ claimedWeek, walletAddress, sender, body }) {
  const info = db.prepare(`
    INSERT INTO weekly_chat_messages (claimed_week, wallet_address, sender, body, read_by_admin, read_by_client)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(claimedWeek, walletAddress.toLowerCase(), sender, body, sender === 'admin' ? 1 : 0, sender === 'client' ? 1 : 0);
  return info.lastInsertRowid;
}

function getWeeklyChatMessages(walletAddress, claimedWeek) {
  return db.prepare(`
    SELECT id, claimed_week, wallet_address, sender, body, created_at
    FROM weekly_chat_messages
    WHERE LOWER(wallet_address) = LOWER(?) AND claimed_week = ?
    ORDER BY id ASC
  `).all(walletAddress, claimedWeek);
}

// reader = 'admin' marca como leídos los mensajes del cliente, y viceversa.
function markWeeklyChatRead(walletAddress, claimedWeek, reader) {
  const col = reader === 'admin' ? 'read_by_admin' : 'read_by_client';
  const otherSender = reader === 'admin' ? 'client' : 'admin';
  db.prepare(`UPDATE weekly_chat_messages SET ${col} = 1 WHERE LOWER(wallet_address) = LOWER(?) AND claimed_week = ? AND sender = ?`)
    .run(walletAddress, claimedWeek, otherSender);
}

// Hilos para el panel de admin: uno por wallet+semana, con último mensaje y no leídos.
function getWeeklyChatThreads() {
  const rows = db.prepare(`
    SELECT wallet_address, claimed_week, MAX(id) as last_id,
      SUM(CASE WHEN sender = 'client' AND read_by_admin = 0 THEN 1 ELSE 0 END) as unread
    FROM weekly_chat_messages
    GROUP BY wallet_address, claimed_week
    ORDER BY last_id DESC
  `).all();
  const lastStmt = db.prepare(`SELECT body, sender, created_at FROM weekly_chat_messages WHERE id = ?`);
  return rows.map(row => {
    const last = lastStmt.get(row.last_id);
    return {
      walletAddress: row.wallet_address,
      claimedWeek: row.claimed_week,
      unread: row.unread || 0,
      lastBody: last ? last.body : '',
      lastSender: last ? last.sender : null,
      lastAt: last ? last.created_at : null
    };
  });
}

// Métricas de vistas del mensaje de la Chave Semanal (cuántos distintos la vieron).
function recordWeeklyMessageView(walletAddress, claimedWeek) {
  if (!walletAddress || !claimedWeek) return;
  try {
    db.prepare(`INSERT OR IGNORE INTO weekly_message_views (wallet_address, claimed_week) VALUES (?, ?)`)
      .run(walletAddress.toLowerCase(), claimedWeek);
  } catch (_) {}
}

function getWeeklyMessageViewCount(claimedWeek) {
  return db.prepare(`SELECT COUNT(*) as count FROM weekly_message_views WHERE claimed_week = ?`).get(claimedWeek)?.count || 0;
}

// Mapa { semana: nº de vistas } para todas las semanas con vistas registradas.
function getWeeklyMessageViewCounts() {
  const rows = db.prepare(`SELECT claimed_week, COUNT(*) as count FROM weekly_message_views GROUP BY claimed_week`).all();
  const map = {};
  rows.forEach(r => { map[r.claimed_week] = r.count; });
  return map;
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

function getScheduledMessages() {
  return db.prepare(`SELECT * FROM scheduled_messages ORDER BY send_at DESC`).all();
}

function insertScheduledMessage({ subject, body, levelFilter, rsvpEventId, actionType, sendAt }) {
  const stmt = db.prepare(`
    INSERT INTO scheduled_messages (subject, body, level_filter, rsvp_event_id, action_type, send_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(subject, body, levelFilter || 'all', rsvpEventId || null, actionType || null, sendAt).lastInsertRowid;
}

function updateScheduledMessage(id, { subject, body, levelFilter, rsvpEventId, actionType, sendAt, status }) {
  const fields = [];
  const vals = [];
  if (subject !== undefined)      { fields.push('subject = ?');       vals.push(subject); }
  if (body !== undefined)         { fields.push('body = ?');          vals.push(body); }
  if (levelFilter !== undefined)  { fields.push('level_filter = ?');  vals.push(levelFilter); }
  if (rsvpEventId !== undefined)  { fields.push('rsvp_event_id = ?');  vals.push(rsvpEventId); }
  if (actionType !== undefined)   { fields.push('action_type = ?');   vals.push(actionType); }
  if (sendAt !== undefined)       { fields.push('send_at = ?');       vals.push(sendAt); }
  if (status !== undefined)       { fields.push('status = ?');        vals.push(status); }
  if (!fields.length) return;
  vals.push(id);
  db.prepare(`UPDATE scheduled_messages SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

function deleteScheduledMessage(id) {
  db.prepare(`DELETE FROM scheduled_messages WHERE id = ?`).run(id);
}


// ==================== BANCO DO CORCHO ($CORCHO) ====================

function getCorchoBalance(walletAddress) {
  if (!walletAddress) return { balance: 0, totalEarned: 0, totalSpent: 0 };
  const row = db.prepare(
    `SELECT balance, total_earned, total_spent FROM corcho_balances WHERE LOWER(wallet_address) = LOWER(?)`
  ).get(walletAddress);
  return {
    balance: row ? row.balance : 0,
    totalEarned: row ? row.total_earned : 0,
    totalSpent: row ? row.total_spent : 0
  };
}

function addCorchoCoins(walletAddress, amount, type, description, referenceId = null) {
  if (!walletAddress || !amount || amount <= 0) return { added: false, reason: 'invalid_params' };
  const w = walletAddress.toLowerCase();
  
  // Idempotencia para recompensas con referenceId (checkin, level_award, etc.)
  if (referenceId && ['checkin', 'level_award', 'campaign_visit', 'referral'].includes(type)) {
    const existing = db.prepare(
      `SELECT id FROM corcho_transactions WHERE LOWER(wallet_address) = ? AND type = ? AND reference_id = ? LIMIT 1`
    ).get(w, type, String(referenceId));
    if (existing) return { added: false, alreadyGranted: true };
  }

  db.prepare(`
    INSERT INTO corcho_balances (wallet_address, balance, total_earned, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(wallet_address) DO UPDATE SET
      balance = balance + excluded.balance,
      total_earned = total_earned + excluded.total_earned,
      updated_at = datetime('now')
  `).run(w, amount, amount);

  db.prepare(`
    INSERT INTO corcho_transactions (wallet_address, amount, type, description, reference_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(w, amount, type, description, referenceId ? String(referenceId) : null);

  return { added: true, newBalance: getCorchoBalance(w).balance };
}

function spendCorchoCoins(walletAddress, amount, type, description, referenceId = null) {
  if (!walletAddress || !amount || amount <= 0) return { ok: false, error: 'invalid_amount' };
  const w = walletAddress.toLowerCase();

  const current = db.prepare(
    `SELECT balance FROM corcho_balances WHERE LOWER(wallet_address) = ?`
  ).get(w);
  const bal = current ? current.balance : 0;
  if (bal < amount) {
    return { ok: false, error: 'insufficient_balance', currentBalance: bal, required: amount };
  }

  db.prepare(`
    UPDATE corcho_balances
    SET balance = balance - ?,
        total_spent = total_spent + ?,
        updated_at = datetime('now')
    WHERE LOWER(wallet_address) = ?
  `).run(amount, amount, w);

  db.prepare(`
    INSERT INTO corcho_transactions (wallet_address, amount, type, description, reference_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(w, -amount, type, description, referenceId ? String(referenceId) : null);

  return { ok: true, newBalance: bal - amount };
}

function getCorchoHistory(walletAddress, limit = 20) {
  if (!walletAddress) return [];
  return db.prepare(`
    SELECT id, amount, type, description, reference_id, created_at
    FROM corcho_transactions
    WHERE LOWER(wallet_address) = LOWER(?)
    ORDER BY id DESC LIMIT ?
  `).all(walletAddress, limit);
}

function transferNftWithFee(fromWallet, toWallet, nftType, nftId, feeAmount) {
  if (!fromWallet || !toWallet || !nftType || !nftId) return { ok: false, error: 'invalid_params' };
  const fromW = fromWallet.toLowerCase();
  const toW = toWallet.toLowerCase();

  if (fromW === toW) return { ok: false, error: 'same_wallet' };

  // 1. Deducir peaje en $CORCHO
  const spendRes = spendCorchoCoins(fromW, feeAmount, 'nft_transfer_fee', `Peaje por traspaso de NFT (${nftType} #${nftId}) a ${toW.slice(0,6)}…${toW.slice(-4)}`, nftId);
  if (!spendRes.ok) return spendRes;

  // 2. Ejecutar traspaso
  if (nftType === 'level') {
    const levelNum = parseInt(nftId, 10);
    const mint = db.prepare(`
      SELECT id FROM mints WHERE LOWER(wallet_address) = ? AND level = ? AND status = 'success' LIMIT 1
    `).get(fromW, levelNum);

    if (!mint) {
      // Revertir cobro
      addCorchoCoins(fromW, feeAmount, 'admin_adjustment', 'Reembolso por fallo en traspaso NFT', nftId);
      return { ok: false, error: 'nft_not_owned' };
    }

    db.prepare(`UPDATE mints SET wallet_address = ? WHERE id = ?`).run(toW, mint.id);
  } else if (nftType === 'achievement') {
    const mint = db.prepare(`
      SELECT id FROM achievement_mints WHERE LOWER(wallet_address) = ? AND (achievement_id = ? OR id = ?) LIMIT 1
    `).get(fromW, nftId, parseInt(nftId, 10) || -1);

    if (!mint) {
      addCorchoCoins(fromW, feeAmount, 'admin_adjustment', 'Reembolso por fallo en traspaso NFT', nftId);
      return { ok: false, error: 'nft_not_owned' };
    }

    db.prepare(`UPDATE achievement_mints SET wallet_address = ? WHERE id = ?`).run(toW, mint.id);
  }

  // 3. Registrar en nft_transfers
  db.prepare(`
    INSERT INTO nft_transfers (nft_type, nft_id, from_wallet, to_wallet, fee_paid, token_id, private_key_enc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'completed')
  `).run(nftType, String(nftId), fromW, toW, feeAmount, parseInt(nftId, 10) || 0, '');

  return { ok: true, newBalance: spendRes.newBalance };
}

// Catálogo dinámico de artículos/canjes en $CORCHO
function getCorchoItems(onlyActive = true) {
  if (onlyActive) {
    return db.prepare(`SELECT * FROM corcho_items WHERE active = 1 ORDER BY price_corcho ASC`).all();
  }
  return db.prepare(`SELECT * FROM corcho_items ORDER BY price_corcho ASC`).all();
}

function addCorchoItem({ name, emoji, priceCorcho, description }) {
  if (!name || !priceCorcho || isNaN(parseInt(priceCorcho, 10))) {
    throw new Error('Nombre y precio en $CORCHO requeridos');
  }
  const info = db.prepare(`
    INSERT INTO corcho_items (name, emoji, price_corcho, description, active)
    VALUES (?, ?, ?, ?, 1)
  `).run(name.trim(), emoji || '🎁', parseInt(priceCorcho, 10), description ? description.trim() : null);

  return db.prepare(`SELECT * FROM corcho_items WHERE id = ?`).get(info.lastInsertRowid);
}

function updateCorchoItem(id, { name, emoji, priceCorcho, description, active }) {
  const fields = [], vals = [];
  if (name !== undefined) { fields.push('name = ?'); vals.push(name.trim()); }
  if (emoji !== undefined) { fields.push('emoji = ?'); vals.push(emoji || '🎁'); }
  if (priceCorcho !== undefined) { fields.push('price_corcho = ?'); vals.push(parseInt(priceCorcho, 10) || 0); }
  if (description !== undefined) { fields.push('description = ?'); vals.push(description ? description.trim() : null); }
  if (active !== undefined) { fields.push('active = ?'); vals.push(active ? 1 : 0); }
  if (!fields.length) return db.prepare(`SELECT * FROM corcho_items WHERE id = ?`).get(id);

  vals.push(id);
  db.prepare(`UPDATE corcho_items SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return db.prepare(`SELECT * FROM corcho_items WHERE id = ?`).get(id);
}

function deleteCorchoItem(id) {
  return db.prepare(`DELETE FROM corcho_items WHERE id = ?`).run(id).changes > 0;
}




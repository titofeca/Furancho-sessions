const { db, getClaimedLevels, getVisitCount } = require('./db/database');
const wallet = '0x3bdE3779DB08057A372b36577A999c34A268C54D';
try {
    const levels = getClaimedLevels(wallet);
    const visitCount = getVisitCount(wallet);
    const activeSession = db.prepare(`SELECT id FROM sessions WHERE LOWER(wallet_address) = LOWER(?) AND exit_time IS NULL LIMIT 1`).get(wallet);
    const pendingApproval = db.prepare(`SELECT level, level_name FROM mints WHERE LOWER(wallet_address) = LOWER(?) AND status = 'pending_approval' ORDER BY level DESC LIMIT 1`).get(wallet);
    const serialsByLevel = {};
    levels.forEach(lvl => {
      const row = db.prepare(`SELECT mint_serial FROM mints WHERE LOWER(wallet_address) = LOWER(?) AND level = ? AND status != 'failed' LIMIT 1`).get(wallet, lvl);
      if (row?.mint_serial) serialsByLevel[lvl] = row.mint_serial;
    });

    const TZ = `'+2 hours'`;
    const visits = db.prepare(`
      SELECT day, (SELECT title FROM events WHERE event_date = day) as event_title
      FROM (
        SELECT date(entry_time, ${TZ}) as day FROM sessions WHERE LOWER(wallet_address) = LOWER(?) AND counted_as_visit = 1
        UNION
        SELECT date(visited_at) as day FROM visits WHERE LOWER(wallet_address) = LOWER(?)
      )
      ORDER BY day DESC
    `).all(wallet, wallet);

    console.log({ levels, visitCount, hasActiveSession: !!activeSession, pendingApproval: pendingApproval || null, serialsByLevel, visits });
} catch (e) {
    console.log("CRASHED:", e);
}

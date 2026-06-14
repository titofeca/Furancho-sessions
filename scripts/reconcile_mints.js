const db = require('../db/database').db;
const { insertMint } = require('../db/database');
const LEVEL_NAMES = { 1: 'O Cautivo', 2: 'O Cunqueiro', 3: 'O Larpeiro', 4: 'O Presidente do Furancho' };

function reconcileMints() {
  let added = 0;

  // 1. Limpiar o revertir minteos de pruebas (demo) en niveles 3 y 4
  const resetDemo = db.prepare(`
    UPDATE mints 
    SET status = 'pending_approval' 
    WHERE level >= 3 
      AND status = 'success' 
      AND (crossmint_action_id IS NULL OR crossmint_action_id LIKE 'demo_%')
  `).run();
  added += resetDemo.changes;

  // 2. Comprobar todas las wallets para asegurar que tienen los niveles que se merecen
  const wallets = db.prepare(`
    SELECT DISTINCT LOWER(wallet_address) as wallet_address FROM (
      SELECT wallet_address FROM sessions WHERE counted_as_visit = 1
      UNION
      SELECT wallet_address FROM visits
    )
  `).all().map(r => r.wallet_address);

  for (const wallet of wallets) {
    const visitCount = require('../db/database').getVisitCount(wallet);
    
    const requiredLevels = [];
    if (visitCount >= 1) requiredLevels.push({ lvl: 1, status: 'success' });
    if (visitCount >= 2) requiredLevels.push({ lvl: 2, status: 'success' });
    if (visitCount >= 4) requiredLevels.push({ lvl: 3, status: 'pending_approval' });
    if (visitCount >= 12) requiredLevels.push({ lvl: 4, status: 'pending_approval' });

    for (const reqLvl of requiredLevels) {
      const exists = db.prepare(`SELECT id FROM mints WHERE LOWER(wallet_address) = LOWER(?) AND level = ? AND status != 'failed'`).get(wallet, reqLvl.lvl);
      if (!exists) {
        insertMint({
          email: null,
          level: reqLvl.lvl,
          levelName: LEVEL_NAMES[reqLvl.lvl],
          walletAddress: wallet,
          status: reqLvl.status,
          ipAddress: 'reconcile'
        });
        added++;
      }
    }
  }
  return added;
}

module.exports = { reconcileMints };

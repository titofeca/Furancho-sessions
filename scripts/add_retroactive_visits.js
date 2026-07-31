const { db, getVisitCount, recordCampaignVisit } = require('../db/database');
const corcho = require('../services/corcho');
const campaign = require('../services/campaign');
const { awardLevelByVisits } = require('../routes/mint');

const targetDates = [
  { dateStr: '2026-07-19', timeStr: '18:00:00' },
  { dateStr: '2026-07-22', timeStr: '18:00:00' },
  { dateStr: '2026-07-26', timeStr: '18:00:00' }
];

const tables = ['sessions', 'user_profiles', 'corcho_balances', 'campaign_visits', 'summer_passport_winners', 'event_rsvps', 'vip_reservations'];
const walletsSet = new Set();
for (const t of tables) {
  try {
    const rows = db.prepare(`SELECT DISTINCT wallet_address FROM ${t}`).all();
    rows.forEach(r => {
      if (r.wallet_address && /^0x[a-fA-F0-9]{40}$/i.test(r.wallet_address)) {
        walletsSet.add(r.wallet_address.toLowerCase());
      }
    });
  } catch (e) {}
}
walletsSet.add('0x6fc50fbf91ae0b5791dd8458455ece015e25394b');

const wallets = Array.from(walletsSet);
console.log(`Processing ${wallets.length} wallets for retroactive visits on July 19, 22, and 26 at 18:00...`);

let totalSessionsAdded = 0;
let totalCampaignVisitsAdded = 0;

for (const walletAddress of wallets) {
  for (const item of targetDates) {
    const dbTime = `${item.dateStr} ${item.timeStr}`;
    
    // 1. Insert session if not exists for this wallet and date
    const existingSession = db.prepare(`
      SELECT id FROM sessions 
      WHERE LOWER(wallet_address) = LOWER(?) 
        AND date(entry_time) = ?
    `).get(walletAddress, item.dateStr);

    if (!existingSession) {
      db.prepare(`
        INSERT INTO sessions (wallet_address, entry_time, counted_as_visit) 
        VALUES (?, ?, 1)
      `).run(walletAddress, dbTime);
      totalSessionsAdded++;
    }

    // 2. Insert campaign visit (Reto de los 5)
    try {
      const campResult = campaign.recordVisitByDate(walletAddress, item.dateStr);
      if (campResult && campResult.counted) {
        totalCampaignVisitsAdded++;
      }
    } catch (e) {
      console.error(`Error in campaign visit for ${walletAddress} on ${item.dateStr}:`, e.message);
    }

    // 3. Grant 2 $CORCHO for Terraza visit
    try {
      corcho.rewardCampaignVisit(walletAddress, item.dateStr);
    } catch (e) {}
  }

  // 4. Update level based on new total visits
  try {
    const visitCount = getVisitCount(walletAddress);
    awardLevelByVisits({ walletAddress, visitCount });
  } catch (e) {}
}

console.log(`Done! Added ${totalSessionsAdded} sessions and ${totalCampaignVisitsAdded} campaign visits across ${wallets.length} wallets.`);

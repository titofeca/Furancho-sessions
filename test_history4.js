const { db } = require('./db/database');
const w = '0x3bdE3779DB08057A372b36577A999c34A268C54D';
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
      `).get(w);
console.log(activeReferredFriendsRow);

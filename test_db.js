const { getVisitCount, db } = require('./db/database');
const w = db.prepare('SELECT wallet_address FROM mints LIMIT 1').get().wallet_address;
console.log('Wallet:', w);
try {
  console.log('Visits:', getVisitCount(w));
} catch(e) {
  console.log('Error:', e.message);
}

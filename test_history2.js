const { db, getVisitCount } = require('./db/database');
const w = db.prepare('SELECT wallet_address FROM sessions LIMIT 1').get().wallet_address;
console.log('Wallet with sessions:', w);
console.log('Visits:', getVisitCount(w));

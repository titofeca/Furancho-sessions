const { db, getCorchoRanking } = require('./db/database');
const wallet = '0x3bdE3779DB08057A372b36577A999c34A268C54D';
const rank = getCorchoRanking(wallet);
console.log("Rank for", wallet, ":", rank);

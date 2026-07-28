const { db } = require('./db/database');
const result = db.prepare(`
  UPDATE sessions 
  SET counted_as_visit = 1 
  WHERE strftime('%w', entry_time) = '4' 
    AND strftime('%H', entry_time) >= '16'
`).run();
console.log("Restored:", result.changes);

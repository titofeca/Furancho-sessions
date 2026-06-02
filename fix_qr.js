const fs = require('fs');
const path = './routes/qr.js';
let content = fs.readFileSync(path, 'utf8');

// Eliminar la constante estática
content = content.replace("const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';", "");

// Reemplazar la generación de URL en /checkin
content = content.replace(
  "const claimUrl = `${BASE_URL}/claim`;",
  "const protocol = req.headers['x-forwarded-proto'] || req.protocol;\n  const claimUrl = `${protocol}://${req.get('host')}/claim`;"
);

// Reemplazar la generación de URL en /checkin/download
content = content.replace(
  "const claimUrl = `${BASE_URL}/claim`;",
  "const protocol = req.headers['x-forwarded-proto'] || req.protocol;\n  const claimUrl = `${protocol}://${req.get('host')}/claim`;"
);

// Reemplazar la generación de URL en /:level y /:level/download
content = content.replace(
  /const claimUrl = `\$\{BASE_URL\}\/claim\?level=\$\{level\}`;/g,
  "const protocol = req.headers['x-forwarded-proto'] || req.protocol;\n  const claimUrl = `${protocol}://${req.get('host')}/claim?level=${level}`;"
);

fs.writeFileSync(path, content);
console.log('Done');

const fs = require('fs');
const path = './routes/mint.js';
let content = fs.readFileSync(path, 'utf8');

const oldLogic = `    // Si viene un nivel específico (QR manual), validamos si ya lo tiene
    if (level) {
      if (checkDuplicate(walletAddress, level)) {
        return res.status(409).json({ message: \`Ya tienes el pase Nivel \${level} (\${LEVEL_NAMES[level]}).\` });
      }
      targetLevel = level;
      targetLevelName = LEVEL_NAMES[level];
    } else {`;

const newLogic = `    // Si viene un nivel específico (QR manual), le damos ese nivel.
    // Si ya lo tiene, sube al siguiente nivel automáticamente (hasta el 4).
    if (level) {
      let requestedLevel = parseInt(level);
      
      // Mientras ya tenga el nivel solicitado, le subimos 1 nivel
      while (requestedLevel <= 4 && checkDuplicate(walletAddress, requestedLevel)) {
        requestedLevel++;
      }
      
      if (requestedLevel > 4) {
        return res.status(409).json({ message: 'Ya tienes todos los pases hasta el Nivel Máximo (Presidente).' });
      }
      
      targetLevel = requestedLevel;
      targetLevelName = LEVEL_NAMES[targetLevel];
    } else {`;

content = content.replace(oldLogic, newLogic);
fs.writeFileSync(path, content);
console.log('Fixed');

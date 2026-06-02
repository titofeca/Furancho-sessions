const fs = require('fs');
const path = './routes/mint.js';
let content = fs.readFileSync(path, 'utf8');

const oldLogic = `    // Determinar si corresponde un nivel por salto manual o por visitas
    let targetLevel = null;
    let manualLevel = parseInt(level);

    if (manualLevel && [1, 2, 3, 4].includes(manualLevel)) {
      targetLevel = manualLevel;
    } else {
      if (visitCount === 1) targetLevel = 1;
      else if (visitCount === 2) targetLevel = 2;
      else if (visitCount === 5) targetLevel = 3;
      else if (visitCount === 10) targetLevel = 4;
    }

    if (!targetLevel) {
      // No toca premio, solo registrar visita
      return res.json({
        success: true,
        action: 'visit',
        visitCount,
        message: \`Visita \${visitCount} registrada correctamente.\`
      });
    }

    const levelName = LEVEL_NAMES[targetLevel];

    // Verificar duplicado por seguridad (aunque por lógica de visitas no debería pasar)
    const isDuplicate = checkDuplicate(walletAddress, sanitizedEmail, targetLevel);
    if (isDuplicate) {
      return res.json({
        success: true,
        action: 'visit',
        visitCount,
        message: \`Visita \${visitCount} registrada. Ya tenías el pase de este hito.\`
      });
    }`;

const newLogic = `    // Determinar si corresponde un nivel por salto manual o por visitas
    let targetLevel = null;
    let manualLevel = parseInt(level);

    if (manualLevel && [1, 2, 3, 4].includes(manualLevel)) {
      // Logica de auto-mejora si ya tiene el nivel
      targetLevel = manualLevel;
      while (targetLevel <= 4 && checkDuplicate(walletAddress, sanitizedEmail, targetLevel)) {
        targetLevel++;
      }
      
      if (targetLevel > 4) {
        return res.status(409).json({ error: 'Ya tienes todos los pases hasta el Nivel Máximo (Presidente).' });
      }
    } else {
      if (visitCount === 1) targetLevel = 1;
      else if (visitCount === 2) targetLevel = 2;
      else if (visitCount === 5) targetLevel = 3;
      else if (visitCount === 10) targetLevel = 4;
    }

    if (!targetLevel) {
      // No toca premio, solo registrar visita
      return res.json({
        success: true,
        action: 'visit',
        visitCount,
        message: \`Visita \${visitCount} registrada correctamente.\`
      });
    }

    const levelName = LEVEL_NAMES[targetLevel];

    // Verificar duplicado por seguridad en visitas normales
    if (!manualLevel && checkDuplicate(walletAddress, sanitizedEmail, targetLevel)) {
      return res.json({
        success: true,
        action: 'visit',
        visitCount,
        message: \`Visita \${visitCount} registrada. Ya tenías el pase de este hito.\`
      });
    }`;

content = content.replace(oldLogic, newLogic);
fs.writeFileSync(path, content);
console.log('Fixed');

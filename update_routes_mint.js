const fs = require('fs');
const path = './routes/mint.js';
let content = fs.readFileSync(path, 'utf8');

// Añadir las importaciones openSession y closeSession
content = content.replace(
  "const { insertVisit, getVisitCount, checkRecentVisit } = require('../db/database');",
  "const { insertVisit, getVisitCount, checkRecentVisit, openSession, closeSession } = require('../db/database');"
);

// 1. Crear el endpoint /entry
const entryRoute = `
// POST /api/mint/entry
router.post('/entry', mintLimiter, async (req, res) => {
  const { walletAddress, email } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'Falta walletAddress' });

  try {
    const { getVisitCount, openSession, insertMint, updateMintStatus } = require('../db/database');
    const { mintNFT, DEMO_MODE } = require('../services/crossmint');
    
    const visitCount = getVisitCount(walletAddress);
    
    // Si es nuevo cliente (0 visitas), le regalamos el NFT 1 a la entrada
    if (visitCount === 0) {
      openSession(walletAddress); // Abre su sesión
      
      const levelName = LEVEL_NAMES[1];
      const mintId = insertMint({
        email, level: 1, levelName, walletAddress, status: 'pending', ipAddress: req.ip
      });
      
      // Mintear
      const result = await mintNFT({ email, walletAddress, level: 1, levelName });
      updateMintStatus(mintId, 'success', result.walletAddress);
      
      return res.json({
        success: true,
        action: 'mint',
        isNew: true,
        levelName,
        level: 1,
        walletAddress: result.walletAddress,
        demo: DEMO_MODE,
        message: '¡Pase de Bienvenida Entregado! Recuerda fichar a la salida.'
      });
    } else {
      // Cliente recurrente, solo abrimos sesión
      openSession(walletAddress);
      return res.json({
        success: true,
        action: 'entry',
        isNew: false,
        message: 'Benvido a Furancho Sessions, Disfruta! Recuerda fichar a la salida.'
      });
    }
  } catch (error) {
    console.error('Error en /entry:', error.message);
    res.status(500).json({ error: 'Error procesando entrada' });
  }
});
`;

content = content.replace("// POST /api/mint", entryRoute + "\n// POST /api/mint");

// 2. Modificar POST /api/mint para que sea la Salida
// Cambiamos insertVisit por closeSession
content = content.replace("insertVisit(walletAddress, sanitizedEmail, req.ip);", "closeSession(walletAddress);");

// OJO: si la visita de la entrada ya le dio el NFT1, a la salida su getVisitCount será 1.
// PERO wait: closeSession sumará 1 a counted_as_visit!
// Si el usuario es nuevo, getVisitCount era 0. En la entrada no sumamos counted_as_visit (eso pasa al cerrar sesión).
// Entonces al escanear la salida, closeSession pondrá counted_as_visit=1. 
// getVisitCount(walletAddress) ahora será 1.
// Si targetLevel es 1, checkDuplicate saltará porque ya se le minteó en la entrada.
// Esto es PERFECTO. checkDuplicate devolverá true, por lo que no volverá a mintear, sino que dirá "Ya tenías el pase de este hito".
// PERO en el frontend de salida, queremos que vea su progreso (ej. nivel 1).

fs.writeFileSync(path, content);
console.log('Mint routes updated');

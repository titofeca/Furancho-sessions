const fs = require('fs');
const path = '/Users/titofernandez/.gemini/antigravity-ide/brain/e1082425-e471-408c-bcc1-c494e959adbe/task.md';
let content = fs.readFileSync(path, 'utf8');

content = content.replace(/- \[\/\] 2. \*\*Rutas API/g, '- [x] 2. **Rutas API');
content = content.replace(/- \[ \] Crear endpoint/g, '- [x] Crear endpoint');
content = content.replace(/- \[ \] Modificar \`POST \/api\/mint\`/g, '- [x] Modificar `POST /api/mint`');
content = content.replace(/- \[ \] Actualizar \`routes\/qr.js\`/g, '- [x] Actualizar `routes/qr.js`');
content = content.replace(/- \[ \] 3. \*\*Frontend/g, '- [x] 3. **Frontend');
content = content.replace(/- \[ \] Crear pantalla "Benvido"/g, '- [x] Crear pantalla "Benvido"');
content = content.replace(/- \[ \] 4. \*\*Frontend/g, '- [x] 4. **Frontend');
content = content.replace(/- \[ \] Adaptar textos/g, '- [x] Adaptar textos');
content = content.replace(/- \[ \] 5. \*\*Panel Admin/g, '- [x] 5. **Panel Admin');
content = content.replace(/- \[ \] Mostrar los 2 QRs/g, '- [x] Mostrar los 2 QRs');

fs.writeFileSync(path, content);

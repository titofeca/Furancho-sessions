const fs = require('fs');
const path = '/Users/titofernandez/.gemini/antigravity-ide/brain/e1082425-e471-408c-bcc1-c494e959adbe/task.md';
let content = fs.readFileSync(path, 'utf8');

content = content.replace(/- \[\/\] 1. \*\*Base de Datos/g, '- [x] 1. **Base de Datos');
content = content.replace(/- \[ \] Crear tabla \`raffles\`/g, '- [x] Crear tabla `raffles`');
content = content.replace(/- \[ \] Función para obtener/g, '- [x] Función para obtener');
content = content.replace(/- \[ \] Función para registrar/g, '- [x] Función para registrar');
content = content.replace(/- \[ \] 2. \*\*Backend/g, '- [x] 2. **Backend');
content = content.replace(/- \[ \] Crear endpoint de túnel/g, '- [x] Crear endpoint de túnel');
content = content.replace(/- \[ \] Crear endpoint \`POST \/api\/raffle\/start\`/g, '- [x] Crear endpoint `POST /api/raffle/start`');
content = content.replace(/- \[ \] Integrar \`raffle.js\`/g, '- [x] Integrar `raffle.js`');
content = content.replace(/- \[ \] 3. \*\*Panel/g, '- [x] 3. **Panel');
content = content.replace(/- \[ \] Crear la pestaña/g, '- [x] Crear la pestaña');
content = content.replace(/- \[ \] Añadir formulario/g, '- [x] Añadir formulario');
content = content.replace(/- \[ \] Mostrar el estado/g, '- [x] Mostrar el estado');
content = content.replace(/- \[ \] 4. \*\*Cliente/g, '- [x] 4. **Cliente');
content = content.replace(/- \[ \] Conectar cliente al \`EventSource\`/g, '- [x] Conectar cliente al `EventSource`');
content = content.replace(/- \[ \] Crear el modal/g, '- [x] Crear el modal');
content = content.replace(/- \[ \] Mostrar el resultado/g, '- [x] Mostrar el resultado');

fs.writeFileSync(path, content);

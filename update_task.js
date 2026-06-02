const fs = require('fs');
const path = '/Users/titofernandez/.gemini/antigravity-ide/brain/e1082425-e471-408c-bcc1-c494e959adbe/task.md';
let content = fs.readFileSync(path, 'utf8');

content = content.replace(/- \[\/\] 1. \*\*Base de Datos/g, '- [x] 1. **Base de Datos');
content = content.replace(/- \[ \] Crear tabla \`sessions\`/g, '- [x] Crear tabla `sessions`');
content = content.replace(/- \[ \] Crear funciones para/g, '- [x] Crear funciones para');
content = content.replace(/- \[ \] 2. \*\*Rutas API/g, '- [/] 2. **Rutas API');

fs.writeFileSync(path, content);

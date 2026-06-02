const fs = require('fs');
let content = fs.readFileSync('./public/admin/index.html', 'utf8');

const oldQrSection = `
        <div class="qr-card">
          <h4>Código Genérico (Suma 1 Visita)</h4>
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">
            Este es el QR principal que debes imprimir. Al escanearlo, el cliente suma una visita. 
            Si alcanza un hito (1, 2, 5 o 10), el sistema le entrega automáticamente la tarjeta que le corresponde.
          </p>
          <img src="/api/qr/checkin" alt="QR Checkin" />
          <a href="/api/qr/checkin/download" class="btn-primary" download style="display: block; margin-top: 15px; text-decoration: none;">Descargar QR de Check-in</a>
        </div>
`;

const newQrSection = `
        <div class="qr-card" style="border: 2px solid #116530;">
          <h4>QR de Entrada (Verde)</h4>
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">
            Imprime este QR para la puerta. Abre la sesión del cliente (o le regala el Nivel 1 si es su primera vez).
          </p>
          <img src="/api/qr/entry" alt="QR Entrada" />
          <a href="/api/qr/entry/download" class="btn-primary" download style="display: block; margin-top: 15px; text-decoration: none; background: #116530;">Descargar QR de ENTRADA</a>
        </div>

        <div class="qr-card" style="border: 2px solid #8B0000;">
          <h4>QR de Salida (Rojo)</h4>
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">
            Imprime este QR para el final de la barra o la salida. Cierra la sesión, suma la visita, y les entrega el NFT de premio si les toca.
          </p>
          <img src="/api/qr/checkin" alt="QR Salida" />
          <a href="/api/qr/checkin/download" class="btn-primary" download style="display: block; margin-top: 15px; text-decoration: none; background: #8B0000;">Descargar QR de SALIDA</a>
        </div>
`;

content = content.replace(oldQrSection, newQrSection);
fs.writeFileSync('./public/admin/index.html', content);

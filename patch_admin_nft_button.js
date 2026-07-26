const fs = require('fs');
let content = fs.readFileSync('public/admin/index.html', 'utf8');

const htmlToInsert = `
        <div style="border-top:1px solid rgba(42,21,9,0.1); margin:16px 0; padding-top:16px;">
          <label style="font-size:11px; font-weight:700; color:var(--text-muted); display:block; margin-bottom:4px;">Botón Dorado Principal (Acceso directo a NFT)</label>
          <p style="font-size:10.5px; color:var(--text-muted); margin:0 0 10px;">Si eliges un NFT, los clientes que lo posean verán un botón dorado gigante en su inicio para abrirlo directamente.</p>
          <select id="featured-nft-button" style="width:100%; background:#fff; color:var(--text); border:1.5px solid rgba(42,21,9,0.12); border-radius:12px; padding:11px 13px; font-size:13px; font-family:'Outfit',sans-serif; box-sizing:border-box; margin-bottom:16px;">
            <option value="none">🚫 Ocultar botón dorado</option>
          </select>
        </div>
`;

if (!content.includes('id="featured-nft-button"')) {
  // Insert right before the "Guardar Tarjeta Dorada" button
  content = content.replace(
    '<button onclick="saveFeaturedCardConfig()"',
    htmlToInsert + '\n        <button onclick="saveFeaturedCardConfig()"'
  );
  fs.writeFileSync('public/admin/index.html', content);
}

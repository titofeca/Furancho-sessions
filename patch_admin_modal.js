const fs = require('fs');
let content = fs.readFileSync('public/admin/index.html', 'utf8');

// Insert HTML for modals right before </body>
const modalHTML = `
  <!-- CORPORATE MODALS -->
  <div id="corcho-modal" style="display:none; position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.7); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); align-items:center; justify-content:center; padding:16px; opacity:0; transition:opacity 0.2s;">
    <div style="background:var(--cream,#fbf9f6); width:100%; max-width:340px; border-radius:24px; padding:24px 20px; text-align:center; box-shadow:0 20px 40px rgba(0,0,0,0.3); border:2px solid var(--gold,#c4973a);">
      <div id="cm-icon" style="font-size:36px; margin-bottom:12px;">🪙</div>
      <h3 id="cm-title" style="font-family:'Playfair Display',serif; font-size:20px; font-weight:900; color:var(--wine,#5a1c1d); margin:0 0 10px;">Aviso</h3>
      <div id="cm-body" style="font-family:'Outfit',sans-serif; font-size:14.5px; color:#2A1509; line-height:1.5; margin-bottom:20px; font-weight:500;"></div>
      <div style="display:flex; gap:10px;">
        <button id="cm-cancel" style="flex:1; padding:12px; border-radius:50px; background:rgba(42,21,9,0.06); border:none; color:var(--text-muted,#777); font-family:'Outfit',sans-serif; font-size:14px; font-weight:700; cursor:pointer;">Cancelar</button>
        <button id="cm-ok" style="flex:1; padding:12px; border-radius:50px; background:linear-gradient(135deg,var(--gold,#c4973a),#a97b1f); border:none; color:#fff; font-family:'Outfit',sans-serif; font-size:14px; font-weight:800; cursor:pointer; box-shadow:0 4px 12px rgba(196,151,58,0.3);">Confirmar</button>
      </div>
    </div>
  </div>
  <script>
    function corchoConfirm(body, title = 'Banco do Corcho', icon = '🪙') {
      return new Promise(resolve => {
        const ov = document.getElementById('corcho-modal');
        document.getElementById('cm-icon').textContent = icon;
        document.getElementById('cm-title').textContent = title;
        document.getElementById('cm-body').innerHTML = body;
        const cancelBtn = document.getElementById('cm-cancel');
        cancelBtn.style.display = 'block';
        
        const cleanup = () => {
          ov.style.opacity = '0';
          setTimeout(() => ov.style.display = 'none', 200);
          cancelBtn.onclick = null;
          document.getElementById('cm-ok').onclick = null;
        };
        
        cancelBtn.onclick = () => { cleanup(); resolve(false); };
        document.getElementById('cm-ok').onclick = () => { cleanup(); resolve(true); };
        
        ov.style.display = 'flex';
        requestAnimationFrame(() => ov.style.opacity = '1');
      });
    }
    
    function corchoAlert(body, title = 'Aviso', icon = '⚠️') {
      return new Promise(resolve => {
        const ov = document.getElementById('corcho-modal');
        document.getElementById('cm-icon').textContent = icon;
        document.getElementById('cm-title').textContent = title;
        document.getElementById('cm-body').innerHTML = body;
        const cancelBtn = document.getElementById('cm-cancel');
        cancelBtn.style.display = 'none'; // Hide cancel for alerts
        
        const cleanup = () => {
          ov.style.opacity = '0';
          setTimeout(() => ov.style.display = 'none', 200);
          document.getElementById('cm-ok').onclick = null;
        };
        
        document.getElementById('cm-ok').onclick = () => { cleanup(); resolve(true); };
        
        ov.style.display = 'flex';
        requestAnimationFrame(() => ov.style.opacity = '1');
      });
    }
  </script>
`;

if (!content.includes('id="corcho-modal"')) {
  content = content.replace('</body>', modalHTML + '\n</body>');
}

// Fix _corchoAction
content = content.replace(
  /if \(confirmMsg && !confirm\(confirmMsg\)\) return;/g,
  "if (confirmMsg && !(await corchoConfirm(confirmMsg))) return;"
);
content = content.replace(/alert\(/g, "corchoAlert(");

fs.writeFileSync('public/admin/index.html', content);

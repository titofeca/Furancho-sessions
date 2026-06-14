const fs = require('fs');
const file = 'public/admin/index.html';
let content = fs.readFileSync(file, 'utf8');

// 1. Add Ganadores input
content = content.replace(
  '<input type="text" class="input-field" id="weekly-prize-input" placeholder="Premio (ej: Botella de Viño de la Casa)" style="font-size:14px; margin-bottom:12px; width:100%; box-sizing:border-box;" />',
  `<div style="display:flex; gap:12px; margin-bottom:12px;">
            <div style="flex:1;">
              <input type="text" class="input-field" id="weekly-prize-input" placeholder="Premio (ej: Botella de Viño de la Casa)" style="font-size:14px; width:100%; box-sizing:border-box; margin:0;" />
            </div>
            <div style="width:90px;">
              <input type="number" class="input-field" id="weekly-winners-input" value="1" min="1" max="50" style="font-size:14px; width:100%; box-sizing:border-box; margin:0;" title="Nº Ganadores" />
            </div>
          </div>`
);

// 2. Add winnersCount to save config
content = content.replace(
  `const rules = rulesInput ? rulesInput.value.trim() : '';`,
  `const rules = rulesInput ? rulesInput.value.trim() : '';\n    const winnersInput = document.getElementById('weekly-winners-input');\n    const winnersCount = winnersInput ? winnersInput.value : 1;`
);

content = content.replace(
  `body: JSON.stringify({ week: selectedWeek, prize, rules })`,
  `body: JSON.stringify({ week: selectedWeek, prize, rules, winnersCount })`
);

// 3. Update loadWeeklyRaffleAdmin drop down
content = content.replace(
  /if \(selectEl\.innerHTML\.includes\('Cargando\.\.\.'\) \|\| selectEl\.options\.length <= 1\) {[\s\S]*?selectEl\.innerHTML = `[\s\S]*?`;\s*}/,
  `if (selectEl.innerHTML.includes('Cargando...') || selectEl.options.length <= 1) {
      try {
        const targetWeekData = await fetch('/api/raffle/admin/weekly/target-week', { headers: authHeaders() }).then(r => r.json());
        const targetWeek = targetWeekData.week;
        
        const allWeeks = await fetch('/api/raffle/admin/weekly/all-weeks', { headers: authHeaders() }).then(r => r.json());
        
        // Ensure targetWeek and nextWeek are in the list
        const nextWeek = getClientYearWeek(new Date(weekToMonday(targetWeek).getTime() + 7 * 24 * 60 * 60 * 1000));
        const weeksSet = new Set(allWeeks);
        weeksSet.add(targetWeek);
        weeksSet.add(nextWeek);
        
        const sortedWeeks = Array.from(weeksSet).sort().reverse();
        
        selectEl.innerHTML = sortedWeeks.map(w => {
          let label = weekRangeLabel(w);
          if (w === targetWeek) label = 'Próximo Sorteo — ' + label;
          return \`<option value="\${w}" \${w === targetWeek ? 'selected' : ''}>\${label}</option>\`;
        }).join('');
      } catch (e) { console.error(e); }
    }`
);

// 4. Update loadWeeklyRaffleAdmin winnersCount set
content = content.replace(
  `if (rulesInput && document.activeElement !== rulesInput) {
        rulesInput.value = data.rules || '';
      }`,
  `if (rulesInput && document.activeElement !== rulesInput) {
        rulesInput.value = data.rules || '';
      }
      const winnersInput = document.getElementById('weekly-winners-input');
      if (winnersInput && document.activeElement !== winnersInput) {
        winnersInput.value = data.winnersCount || 1;
      }`
);

// 5. Update winner render logic
content = content.replace(
  `if (winnerAddress) winnerAddress.textContent = data.winnerWallet || '—';

        // Mostrar código de verificación
        const codeEl = document.getElementById('weekly-verification-code');
        if (codeEl) codeEl.textContent = data.verificationCode || '—';`,
  `if (winnerAddress) {
          try {
            const wallets = JSON.parse(data.winnerWallet);
            const codes = JSON.parse(data.verificationCode || "{}");
            let html = '';
            wallets.forEach(w => {
              html += \`<div style="display:flex; justify-content:space-between; margin-bottom:4px; padding-bottom:4px; border-bottom:1px solid rgba(0,0,0,0.05);"><span style="font-family:monospace; font-size:13px;">\${w}</span> <span style="font-weight:bold; color:var(--wine);">\${codes[w] || '—'}</span></div>\`;
            });
            winnerAddress.innerHTML = html;
          } catch(e) {
            winnerAddress.textContent = data.winnerWallet || '—';
          }
        }
        const codeEl = document.getElementById('weekly-verification-code');
        if (codeEl) {
          try { JSON.parse(data.verificationCode); codeEl.style.display = 'none'; }
          catch(e) { codeEl.textContent = data.verificationCode || '—'; codeEl.style.display = 'block'; }
        }`
);

fs.writeFileSync(file, content);
console.log('Patched public/admin/index.html');

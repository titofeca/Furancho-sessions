const fs = require('fs');

function updateHtml(filePath, isEntry) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Replace font imports to include Outfit
  content = content.replace(
    /<link href="https:\/\/fonts.googleapis.com\/css2\?family=Playfair\+Display[^"]+" rel="stylesheet" \/>/g,
    '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet" />'
  );
  if (!content.includes('family=Outfit')) {
      content = content.replace(
        /<link href="https:\/\/fonts.googleapis.com\/css2\?family=Playfair\+Display[^"]+" rel="stylesheet">/g,
        '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet" />'
      );
  }

  // Common CSS enhancements
  const newStyle = `
    :root {
      --bg-dark: #050505;
      --bg-gradient: radial-gradient(circle at top right, #2a0808 0%, #050505 60%);
      --accent-gold: #D4AF37;
      --accent-gold-dark: #AA8529;
      --accent-red: #8B0000;
      --text-main: #FDFBF7;
      --text-muted: #BDB5A1;
      --glass-bg: rgba(20, 20, 20, 0.6);
      --glass-border: rgba(212, 175, 55, 0.2);
    }
    
    body, html {
      margin: 0; padding: 0;
      background: var(--bg-dark);
      background-image: var(--bg-gradient);
      color: var(--text-main);
      font-family: 'Outfit', sans-serif;
      min-height: 100vh;
      background-attachment: fixed;
    }

    h1, h2, h3, .nft-card-title, .nft-title {
      font-family: 'Playfair Display', serif;
      letter-spacing: 0.5px;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--accent-gold), var(--accent-gold-dark));
      color: #000;
      border: none;
      border-radius: 50px;
      padding: 16px 28px;
      font-size: 16px;
      font-weight: 600;
      font-family: 'Outfit', sans-serif;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(212, 175, 55, 0.3);
      transition: all 0.3s ease;
      text-transform: uppercase;
      letter-spacing: 1px;
      width: 100%;
    }
    
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 25px rgba(212, 175, 55, 0.5);
    }

    .glass-card {
      background: var(--glass-bg);
      backdrop-filter: blur(15px);
      -webkit-backdrop-filter: blur(15px);
      border: 1px solid var(--glass-border);
      border-radius: 24px;
      padding: 24px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    
    .success-icon {
      background: linear-gradient(135deg, var(--accent-gold), var(--accent-gold-dark));
      color: #000;
      box-shadow: 0 0 30px rgba(212, 175, 55, 0.4);
    }
  `;

  if (isEntry) {
      // For entry, inject styles directly in head
      content = content.replace(/<style>[\s\S]*?<\/style>/, ''); // Remove old style if any
      content = content.replace('</head>', `<style>${newStyle}</style></head>`);
      
      // Update DOM classes
      content = content.replace(/background: linear-gradient[^;]+; border: 1\.5px solid[^;]+; border-radius: 20px; padding: 24px;[^"]+"/g, 'glass-card"');
      content = content.replace(/color: var\(--accent\)/g, 'color: var(--accent-gold)');
  } else {
      // For claim
      content = content.replace(/font-family: 'Inter', sans-serif;/g, "font-family: 'Outfit', sans-serif;");
      content = content.replace(/--bg: #0a0a0a;/g, "--bg: #050505; --accent: #D4AF37;");
      content = content.replace(/background: var\(--bg\);/g, "background: var(--bg);\n      background-image: radial-gradient(circle at top right, #2a0808 0%, #050505 60%);\n      background-attachment: fixed;");
      content = content.replace(/background: linear-gradient\(135deg, rgba\(255,255,255,0\.06\)[^"]+"/g, 'glass-card"');
      content = content.replace(/background: rgba\(255,255,255,0\.04\)[^"]+"/g, 'glass-card" style="margin-bottom: 20px; text-align: left;"');
      content = content.replace(/border-radius: 14px;/g, 'border-radius: 50px;');
  }

  fs.writeFileSync(filePath, content);
}

updateHtml('./public/entry/index.html', true);
updateHtml('./public/claim/index.html', false);
console.log("Design enhanced");

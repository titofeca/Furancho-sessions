document.addEventListener('DOMContentLoaded', async () => {
  let privateKey = localStorage.getItem('furancho_private_key');
  let walletAddress = localStorage.getItem('furancho_wallet_address');
  
  if (!privateKey || !walletAddress) {
    try {
      const res = await fetch('/api/mint/create-wallet', { method: 'POST' });
      const data = await res.json();
      privateKey = data.privateKey;
      walletAddress = data.address;
      localStorage.setItem('furancho_private_key', privateKey);
      localStorage.setItem('furancho_wallet_address', walletAddress);
    } catch (e) {
      alert("Error al generar la cartera. Inténtalo más tarde.");
      return;
    }
  }

  // Hit entry endpoint
  try {
    const res = await fetch('/api/mint/entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress })
    });
    const data = await res.json();
    
    document.getElementById('screen-loading').style.display = 'none';
    document.getElementById('screen-success').style.display = 'flex';
    
    if (data.isNew) {
      document.getElementById('icon-container').innerText = '🎉';
      document.getElementById('title-container').innerText = '¡Bienvenido!';
      document.getElementById('msg-container').innerText = data.message;
      document.getElementById('nft-container').style.display = 'block';
    }
    // Si no es nuevo, se muestra lo que ya hay (Benvido a Furancho Sessions)
    
  } catch (e) {
    alert("Error al registrar entrada.");
  }
});

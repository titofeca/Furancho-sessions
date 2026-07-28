const http = require('http');
http.get('http://localhost:3050/api/mint/history?wallet=0x1234567890123456789012345678901234567890', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('Status:', res.statusCode, 'Body:', data));
}).on('error', (err) => console.log('Error:', err.message));

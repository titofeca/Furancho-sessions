const http = require('http');
http.get('http://localhost:3050/api/mint/history?wallet=0x3bdE3779DB08057A372b36577A999c34A268C54D', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('Status:', res.statusCode, 'Body:', data));
}).on('error', (err) => console.log('Error:', err.message));

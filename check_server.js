const fs = require('fs');
let content = fs.readFileSync('./server.js', 'utf8');
if (!content.includes('app.use(\'/entry\'')) {
  content = content.replace("app.use('/claim', express.static(path.join(__dirname, 'public/claim')));", "app.use('/claim', express.static(path.join(__dirname, 'public/claim')));\napp.use('/entry', express.static(path.join(__dirname, 'public/entry')));");
  fs.writeFileSync('./server.js', content);
  console.log('Added entry static route to server.js');
} else {
  console.log('Already there');
}

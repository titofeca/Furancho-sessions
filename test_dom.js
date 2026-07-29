const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const html = fs.readFileSync('public/claim/index.html', 'utf8');
const dom = new JSDOM(html);
const window = dom.window;
const document = window.document;

const scripts = html.match(/<script>([\s\S]*?)<\/script>/g);
if (scripts) {
  scripts.forEach((s, i) => {
    const code = s.replace(/<\/?script>/g, '');
    try {
      window.eval(code);
    } catch (e) {
      console.error('Error evaluating script', i, e);
    }
  });
}
console.log('typeof openCorchoItemsModal:', typeof window.openCorchoItemsModal);
if (typeof window.openCorchoItemsModal === 'function') {
  try {
    window.switchCorchoCatTab = () => {};
    window.openCorchoItemsModal();
    console.log('Modal display:', document.getElementById('corcho-items-modal').style.display);
  } catch(e) {
    console.error('Error running openCorchoItemsModal', e);
  }
}

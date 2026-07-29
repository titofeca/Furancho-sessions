const fs = require('fs');
const html = fs.readFileSync('public/claim/index.html', 'utf8');
const scripts = html.match(/<script>([\s\S]*?)<\/script>/g);
let allCode = '';
if (scripts) {
  scripts.forEach((s) => {
    allCode += s.replace(/<\/?script>/g, '') + '\n';
  });
}
// simple mock of browser globals to catch reference errors at top level
const mock = `
const window = { location: { search: '' }, addEventListener: ()=>{} };
const document = { getElementById: ()=>({ style: {}, classList: { add: ()=>{}, remove: ()=>{} }, addEventListener: ()=>{} }), querySelector: ()=>null, querySelectorAll: ()=>[] };
const localStorage = { getItem: ()=>null, setItem: ()=>{} };
const navigator = {};
let fetch = async () => {};
`;
try {
  new Function(mock + allCode);
  console.log("No top-level syntax/reference errors found by simple eval.");
} catch(e) {
  console.log("Top-level error:", e);
}

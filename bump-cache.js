const fs = require('fs');
const path = require('path');

function bumpInFile(filePath) {
    const abs = path.join(__dirname, filePath);
    if (!fs.existsSync(abs)) return;
    let html = fs.readFileSync(abs, 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    // Replace existing script.js?v=... or add if missing
    html = html.replace(/script\.js\?v=[^"']+/g, `script.js?v=${stamp}`);
    html = html.replace(/script\.js(?=["'])/g, `script.js?v=${stamp}`);
    // Optionally bump styles.css too if it has a v param
    html = html.replace(/styles\.css\?v=[^"']+/g, `styles.css?v=${stamp}`);
    fs.writeFileSync(abs, html, 'utf8');
    console.log(`Bumped cache version in ${filePath} -> ${stamp}`);
}

['public/index.html', 'public/grading.html'].forEach(bumpInFile);



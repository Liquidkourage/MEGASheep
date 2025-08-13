const fs = require('fs');
const path = require('path');

function bumpInFile(abs, stamp) {
    if (!fs.existsSync(abs)) return false;
    let html = fs.readFileSync(abs, 'utf8');
    const before = html;
    // script.js and styles.css
    html = html.replace(/script\.js\?v=[^"']+/g, `script.js?v=${stamp}`);
    html = html.replace(/(?<=src=")script\.js(?=["'])/g, `script.js?v=${stamp}`);
    html = html.replace(/styles\.css\?v=[^"']+/g, `styles.css?v=${stamp}`);
    html = html.replace(/(?<=href=")styles\.css(?=["'])/g, `styles.css?v=${stamp}`);
    if (html !== before) {
        fs.writeFileSync(abs, html, 'utf8');
        console.log(`Bumped cache version in ${path.relative(process.cwd(), abs)} -> ${stamp}`);
        return true;
    }
    return false;
}

function bumpAll() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const pub = path.join(__dirname, 'public');
    if (!fs.existsSync(pub)) return;
    const files = fs.readdirSync(pub).filter(f => f.toLowerCase().endsWith('.html'));
    let changed = 0;
    for (const f of files) {
        const abs = path.join(pub, f);
        if (bumpInFile(abs, stamp)) changed++;
    }
    if (changed === 0) console.log('No cache-bust targets updated.');
}

try { bumpAll(); } catch (e) { console.warn('bump-cache failed:', e?.message); }



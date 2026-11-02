const fs = require('fs');
const content = fs.readFileSync('src/app.ts', 'utf8');
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('subReq') || lines[i].includes('rest =')) {
    console.log(`Line ${i+1}: ${lines[i]}`);
  }
}
console.log('Total lines:', lines.length);
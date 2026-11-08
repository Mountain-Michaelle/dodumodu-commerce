import fs from "node:fs";
const c = fs.readFileSync("C:/Users/Chinedu/Documents/web_work/dodumodu/test-output.log", "utf16le");
const lines = c.split(/\n/);
let fails = 0;
let passes = 0;
let total = 0;
const failLines = [];
lines.forEach((l, i) => {
  const t = l.trim();
  if (t.startsWith("not ok")) {
    fails++;
    failLines.push(`${i+1}: ${t}`);
  }
  if (t.startsWith("ok ") || t.startsWith("not ok")) {
    total++;
  }
});
console.log(`Total assertions: ${total}`);
console.log(`Passed: ${total - fails}`);
console.log(`Failed: ${fails}`);
console.log("\n--- FAILURES ---");
failLines.forEach(f => console.log(f));
// Look for final summary
lines.forEach((l, i) => {
  const t = l.trim();
  if (t.match(/^\d+ tests?/) || t.match(/passed/) || t.match(/failed/) || t.match(/skipped/)) {
    console.log(`\n--- POSSIBLE SUMMARY line ${i+1} ---`);
    console.log(t);
  }
});
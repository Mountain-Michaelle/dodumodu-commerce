import fs from "node:fs";
const c = fs.readFileSync("C:/Users/Chinedu/Documents/web_work/dodumodu/test-output.log", "utf16le");
const lines = c.split(/\n/);
let fails = 0;
let total = 0;
lines.forEach((l, i) => {
  const t = l.trim();
  if (t.startsWith("not ok")) {
    fails++;
    console.log(`FAIL line ${i+1}: ${t}`);
  }
  if (t.startsWith("ok ") || t.startsWith("not ok")) {
    total++;
  }
});
console.log(`\nTotal test assertions: ${total}`);
console.log(`Total failures: ${fails}`);
// Also look for summary lines
lines.forEach((l, i) => {
  const t = l.trim();
  if (t.includes("tests") && (t.includes("passed") || t.includes("failed") || t.includes("✖") || t.includes("✔"))) {
    console.log(`SUMMARY line ${i+1}: ${t}`);
  }
});
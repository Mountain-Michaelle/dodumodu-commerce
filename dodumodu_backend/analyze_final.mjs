import fs from "node:fs";
const path = "C:/Users/Chinedu/Documents/web_work/dodumodu/dodumodu_backend/test-run-1.log";
const raw = fs.readFileSync(path);
const text = Buffer.from(raw).toString("utf16le");
const lines = text.split(/\n/);

let passCount = 0;
let failCount = 0;
let skipCount = 0;
let totalCount = 0;
const failures = [];
const file = path;

for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  // TAP format: "ok N - description" or "not ok N - description"
  const m = t.match/^(ok|not ok)\s+(\d+)\s+-\s+(.*)$/;
  if (m) {
    totalCount++;
    if (m[1] === "ok") {
      passCount++;
    } else {
      failCount++;
      failures.push({ n: parseInt(m[2]), desc: m[3], line: i + 1 });
    }
  }
}

console.log("==============================================");
console.log("  DODUMODU BACKEND - FINAL TEST AUDIT REPORT");
console.log("==============================================");
console.log("");
console.log(`Log file: ${file}`);
console.log(`Total test assertions run: ${totalCount}`);
console.log(`Passed: ${passCount}`);
console.log(`Failed: ${failCount}`);
console.log(`Skipped: ${skipCount}`);
console.log(`Success rate: ${totalCount > 0 ? ((passCount / totalCount) * 100).toFixed(2) : 0}%`);
console.log("");

if (failCount > 0) {
  console.log("----------------------------------------------");
  console.log("  FAILURES (${failCount})");
  console.log("----------------------------------------------");
  failures.forEach((f, idx) => {
    console.log(`  ${idx + 1}. [#${f.n}] ${f.desc}`);
    console.log(`      Log line: ${f.line}`);
  });
  console.log("");
}

console.log("----------------------------------------------");
console.log("  RESULT: " + (failCount === 0 ? "ALL TESTS PASSED" : `${failCount} TEST(S) FAILED`));
console.log("----------------------------------------------");
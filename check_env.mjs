import fs from "node:fs";
const c = fs.readFileSync("C:/Users/Chinedu/Documents/web_work/dodumodu/.env", "utf8");
const lines = c.split(/\r?\n/);
lines.forEach((l, i) => {
  if (l.includes("DATABASE_URL")) {
    console.log(JSON.stringify({ i, len: l.length, last: l.charCodeAt(l.length - 1), line: l }));
  }
});
const fs = require("fs");
const tail = (p, n = 8) => fs.readFileSync(p, "utf8").trim().split("\n").slice(-n).join("\n");
console.log("=== qr.js tail ===");
console.log(tail("src/auth-ui/qr.js"));
console.log("=== qr-logo.mjs head ===");
console.log(fs.readFileSync("src/auth-ui/qr-logo.mjs", "utf8").split("\n").slice(0, 3).join("\n"));
console.log("=== auth.js head ===");
console.log(fs.readFileSync("src/auth-ui/auth.js", "utf8").split("\n").slice(0, 8).join("\n"));
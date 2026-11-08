import { URL } from "node:url";
const url = process.env.DATABASE_URL;
console.log("DATABASE_URL raw:", JSON.stringify(url));
if (url) {
  try {
    const u = new URL(url);
    console.log("hostname:", JSON.stringify(u.hostname));
    console.log("pathname:", JSON.stringify(u.pathname));
    console.log("db name:", JSON.stringify(u.pathname.slice(1)));
  } catch (e) {
    console.log("URL parse error:", e.message);
  }
} else {
  console.log("DATABASE_URL is not set");
}
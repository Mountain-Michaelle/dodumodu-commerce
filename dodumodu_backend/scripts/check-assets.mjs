// Fails when anything served to a browser could expose source notes or secrets. Run by `npm run check:assets` and by
// src/security/served-assets.test.ts. It looks at the FINAL generated output, not the sources.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const SECRET_LIKE = [
  /process\.env\./, /import\.meta\.env/, /\b[A-Z][A-Z0-9_]{3,}_(?:SECRET|TOKEN|PASSWORD)\b/, /\b[A-Z][A-Z0-9_]{3,}_(?:API_KEY|PRIVATE_KEY|SECRET_KEY)\b/,
  /postgres(?:ql)?:\/\/[^\s"']*@/, /FILL-IN/i, /\bnpg_[A-Za-z0-9]{8,}/, /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/, /\bghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/, /\bre_[A-Za-z0-9]{16,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const SOURCE_NOTES = [/<your-[a-z-]+>/i, /=====\s*FILE:/, /\bTODO\b|\bFIXME\b/, /sourceMappingURL/, /\/home\/[a-z0-9_-]+\//i, /[A-Z]:\\Users\\/];

export async function assetProblems() {
  const mod = await import(pathToFileURL(join(process.cwd(), "src/generated/adminPages.ts")).href).catch(() => null);
  if (!mod) return ["could not load src/generated/adminPages.ts (run via tsx)"];
  const files = {};
  for (const [k, v] of Object.entries(mod)) {
    if (typeof v === "string") files[k] = v;
    else if (v && typeof v === "object") for (const [n, t] of Object.entries(v)) if (typeof t === "string") files[`${k}/${n}`] = t;
  }
  const problems = [];
  for (const [name, text] of Object.entries(files)) {
    for (const re of SECRET_LIKE) if (re.test(text)) problems.push(`${name}: looks like a secret or env reference (${re})`);
    for (const re of SOURCE_NOTES) if (re.test(text)) problems.push(`${name}: leaves a source note or path (${re})`);
    if (/\.(?:js|css)$|_JS$|_CSS$/.test(name)) {
      const lines = text.split("\n").length;
      if (text.length > 2000 && lines > 12) problems.push(`${name}: not minified (${lines} lines)`);
      if (/\/\*[\s\S]{20,}?\*\//.test(text) || /(^|\n)\s*\/\/ /.test(text)) problems.push(`${name}: still contains comments`);
    }
    if (/HTML$/.test(name) && /<!--/.test(text)) problems.push(`${name}: contains an HTML comment`);
  }
  return problems;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const p = await assetProblems();
  if (p.length) { console.error("served assets:\n - " + p.join("\n - ")); process.exit(1); }
  console.log("served assets: ok");
}

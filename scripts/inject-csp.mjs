import { readFileSync, writeFileSync } from "node:fs";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src ipc: http://ipc.localhost",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const file = "dist/index.html";
const html = readFileSync(file, "utf8");
if (!html.includes("Content-Security-Policy")) {
  const injected = html.replace(
    "<head>",
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
  );
  writeFileSync(file, injected);
  console.log("[inject-csp] CSP injected");
} else {
  console.log("[inject-csp] CSP already present, skipping");
}

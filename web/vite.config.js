import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Reuse CPGChat LAN certs so Desktop Notification has a secure context on :5174
const certDirCandidates = [
  path.resolve(__dirname, "../../cpgchat/certs"),
  path.resolve(__dirname, "../../../cpgchat/certs"),
  "D:/Projects/cpgchat/certs"
];

function firstExisting(dir, names) {
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let https = undefined;
for (const certDir of certDirCandidates) {
  if (!fs.existsSync(certDir)) continue;
  const key = firstExisting(certDir, ["dev-key.pem", "cpgchat.key", "key.pem"]);
  const cert = firstExisting(certDir, ["dev-cert.pem", "cpgchat.crt", "cert.pem"]);
  if (key && cert) {
    https = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    break;
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5174,
    allowedHosts: true,
    https,
    proxy: {
      "/api": { target: "http://127.0.0.1:8788", changeOrigin: true },
      "/socket.io": { target: "http://127.0.0.1:8788", changeOrigin: true, ws: true }
    }
  }
});

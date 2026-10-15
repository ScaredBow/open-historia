import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
function size(dir) { return readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : statSync(path.join(dir, e.name)).size), 0); }
const bytes = size(process.argv[2]);
console.log(`Unthinned App Clip: ${bytes} bytes (limit 100,000,000). App Store thinned-size validation is still required.`);
if (bytes >= 100_000_000) process.exit(1);

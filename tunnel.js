const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT) || 2567;
const isWin = process.platform === 'win32';
const binName = isWin ? 'cloudflared.exe' : 'cloudflared';
const binPath = path.join(__dirname, 'bin', binName);

let command = binPath;
if (!fs.existsSync(binPath)) {
  command = 'cloudflared';
}

console.log(`Starting Cloudflare tunnel pointing to http://localhost:${PORT}...`);

const child = spawn(binPath, ['tunnel', '--url', `http://localhost:${PORT}`], {
  stdio: 'inherit',
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});


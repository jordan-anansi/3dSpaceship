const os = require('os');

const PORT = Number(process.env.PORT) || 2567;

const nets = os.networkInterfaces();
const ip = Object.values(nets)
  .flat()
  .find((n) => n.family === 'IPv4' && !n.internal)?.address;

if (ip) {
  console.log(`Share this URL with players on your network:  http://${ip}:${PORT}`);
} else {
  console.log('No LAN IP found — are you connected to Wi-Fi?');
}

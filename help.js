const os = require('os');

const PORT = Number(process.env.PORT) || 2567;

// Same lookup as lan-url.js — first non-internal IPv4 interface.
const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((n) => n.family === 'IPv4' && !n.internal)?.address;

console.log(`
3dSpaceship

  npm run dev      start the server (restarts on save)
  npm run tunnel   expose it publicly (run in a second terminal)

Connect

  you           http://localhost:${PORT}
  same wifi     ${lan ? `http://${lan}:${PORT}` : '(no wifi connection found)'}
  anywhere      the https://<random>.trycloudflare.com url that
                \`npm run tunnel\` prints — new one each run
`);

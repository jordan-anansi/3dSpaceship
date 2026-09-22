import http from 'http';
import path from 'path';
import express from 'express';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { LobbyRoom } from './rooms/LobbyRoom';

const PORT = Number(process.env.PORT) || 2567;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/audio', express.static(path.join(__dirname, '..', 'audio')));
// Serve the Colyseus client library straight from node_modules so the
// browser always gets the exact version the server was tested against.
app.use(
  '/lib/colyseus.js',
  express.static(path.join(__dirname, '..', 'node_modules', 'colyseus.js', 'dist', 'colyseus.js'))
);
// three.module.js imports ./three.core.js internally, so expose the whole build dir
app.use('/lib/three', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'build')));
// addons (GLTFLoader etc.) — mapped to the 'three/addons/' importmap prefix
app.use('/lib/three-addons', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'examples', 'jsm')));

const httpServer = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define('lobby', LobbyRoom);

gameServer.listen(PORT, '0.0.0.0').then(() => {
  console.log(`Serving http://0.0.0.0:${PORT} — on your LAN: http://10.0.0.196:${PORT}`);
});

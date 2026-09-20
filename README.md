# 3dSpaceship

**Give the bots a try** — make a new directory, feed Gemini this repo's URL, and say _"clone this repo, install the dependencies, and start the server so I can play."_

A 3D multiplayer spaceship game built with **Three.js** on the frontend and a **Colyseus** WebSocket game server on Node.js.

---

## Prerequisites

- [Node.js](https://nodejs.org/) (LTS v20+ or v24+)
- npm (included with Node.js)

---

## Quick Start (Local Testing)

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start the development server:**
   ```bash
   npm run dev
   ```
   *(This starts the server with live file-watching; edits to server or client files reload automatically.)*

3. **Play in your browser:**
   - Open **http://localhost:2567**
   - Enter your name and click **Join**.
   - To exit back to the join screen at any time, click the **Exit to Lobby** button in the top right.
   - To test multiplayer locally, open a second browser tab or window, join with a different name, and both ships will appear in the arena!

---

## Playing Together on the Same Local Network (Wi-Fi)

To play with someone connected to the same home Wi-Fi or router:

1. Start the server on the host machine:
   ```bash
   npm run dev
   ```
2. Find your local network IP by running:
   ```bash
   npm run url
   ```
3. Have other players open `http://<your-local-ip>:2567` (for example, `http://192.168.1.232:2567`) on their devices.

---

## Playing Remotely via Cloudflare Tunnel (Over the Internet)

If you and your friends/family are on different networks, you can expose the game server using a free **Cloudflare Tunnel** (no account or router port forwarding required).

### 1. Ensure `cloudflared` is installed

Place the `cloudflared` executable inside the `bin/` directory or install it system-wide:

- **Windows (PowerShell):**
  ```powershell
  New-Item -ItemType Directory -Force -Path "bin"
  Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "bin\cloudflared.exe"
  ```
  *(Or install via winget: `winget install Cloudflare.cloudflared`)*

- **macOS:**
  ```bash
  brew install cloudflared
  ```

- **Linux:**
  ```bash
  mkdir -p bin
  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o bin/cloudflared && chmod +x bin/cloudflared
  ```

### 2. Start the game server

In your first terminal:
```bash
npm run dev
```

### 3. Start the tunnel

In a second terminal:
```bash
npm run tunnel
```

Look for the public URL in the terminal output:
```text
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at:                                          |
|  https://<random-words>.trycloudflare.com                                                  |
+--------------------------------------------------------------------------------------------+
```

Share that `https://...` link with remote players. The game client automatically detects HTTPS and connects securely over encrypted WebSockets (`wss://`).

---

## Flight Controls

| Action | Control |
| :--- | :--- |
| **Capture Mouse** | Click inside the game canvas |
| **Release Mouse** | `Esc` |
| **Pitch & Yaw** | Mouse movement (aim up/down/left/right) |
| **Roll** | `Q` / `E` |
| **Thrust (Forward / Back)** | `W` / `S` |
| **Strafe (Left / Right)** | `A` / `D` |
| **Fire Lasers** | `Spacebar` |
| **Toggle Grid** | `G` |
| **Exit to Lobby** | Click `Exit to Lobby` button |

---

## Available Scripts

- `npm run dev`: Starts the game server with auto-reload (`tsx watch src/index.ts`).
- `npm run start`: Starts the game server in standard production mode.
- `npm run tunnel`: Opens a Cloudflare quick tunnel to share the server over the internet.
- `npm run url`: Prints your local Wi-Fi / LAN IP address to share on your home network.
- `npm run help`: Displays a summary of connection options and commands.

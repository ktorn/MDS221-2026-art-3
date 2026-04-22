# Heart-Wave Interactive Artwork (p5.js + ESP32 WebSocket)

This project is a p5.js interactive artwork that visualizes water-like wave lines and ripples.
The artwork reacts to heart-rate data (BPM) and "pulses" with each beat.

For now, you can run it with simulated BPM data before the ESP32 prototype is ready.

## Files

- `index.html` - app entry
- `style.css` - fullscreen layout + HUD style
- `sketch.js` - p5 rendering + heart-rate simulator + WebSocket input
- `mock-server.js` - optional local WebSocket BPM simulator

## Quick Start (Simulation only)

1. Open `index.html` in a browser (or use a local static server).
2. The artwork starts in `simulation` mode automatically.

## Start p5.js with Python (recommended)

Use a local static server so browser permissions and asset loading behave consistently.

```bash
python3 -m http.server 8000
```

Then open:

- `http://localhost:8000`

If port `8000` is already in use, choose another port:

```bash
python3 -m http.server 8081
```

## Visual behavior mapping

- Initial state (Figure 4 reference): visible line structure + colored geometric shapes (square / triangle / circle).
- Higher BPM (Figure 2 reference): motion increases and the scene shifts toward flowing, layered topographic lines.
- Beat pulse moments (Figure 3 reference): lines and shapes expand outward; figurative geometry fades/dissolves.
- Colors are sampled from your palette (`#8C162C`, `#D95276`, `#8C4579`, `#8C4535`, `#592E25`) over a black background.

## WebSocket Mode (for ESP32 or mock server)

- Press `W` to switch source between:
  - `simulation`
  - `websocket`
- Client expects a WebSocket server at:
  - `ws://localhost:8080`

Expected message format:

```json
{ "bpm": 76.3, "source": "esp32", "ts": 1760000000000 }
```

Only `bpm` is required.

Where to connect ESP32 in code:

- `sketch.js` -> class `HeartRateWebSocket` -> `this.socket.onmessage`
- Send JSON with numeric `bpm`; this value drives all visual transitions.

## Optional: Run the local mock WebSocket server

`mock-server.js` uses the `ws` npm package.

```bash
npm install ws
node mock-server.js
```

Then press `W` in the browser to use WebSocket mode.

## ESP32 Integration Notes

When your ESP32-S3 prototype is ready:

1. Connect heart-rate sensor and compute BPM on the board.
2. Send JSON packets over WebSocket with the same `bpm` field.
3. Keep a stable send interval (for example every 100-250 ms).

The artwork already smooths noisy BPM values and triggers pulse envelopes per beat interval.

## One-pass run checklist

1. Start static page server:
   - `python3 -m http.server 8000`
2. Open `http://localhost:8000`
3. (Optional) Start mock BPM socket:
   - `npm install ws`
   - `node mock-server.js`
4. Press `W` in browser to switch:
   - `simulation` <-> `websocket`

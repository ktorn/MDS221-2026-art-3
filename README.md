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

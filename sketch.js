const WS_URL = "ws://localhost:8080";

let currentBpm = 72;
let smoothedBpm = 72;
let bpmSource = "simulation";
let wsState = "disconnected";

let pulseEnvelope = 0;
let phase = 0;
let lastBeatMs = 0;

let simulator;
let wsInput;

let sourceLabelEl;
let bpmLabelEl;
let wsLabelEl;

function setup() {
  createCanvas(windowWidth, windowHeight);
  noFill();

  sourceLabelEl = document.getElementById("sourceLabel");
  bpmLabelEl = document.getElementById("bpmLabel");
  wsLabelEl = document.getElementById("wsLabel");

  simulator = new HeartRateSimulator();
  wsInput = new HeartRateWebSocket(WS_URL);

  simulator.start();
  updateHud();
}

function draw() {
  updateHeartRate();
  renderWater();
  updateHud();
}

function updateHeartRate() {
  const nextBpm = bpmSource === "simulation" ? simulator.getValue() : wsInput.getValue(currentBpm);

  currentBpm = constrain(nextBpm, 45, 170);
  smoothedBpm = lerp(smoothedBpm, currentBpm, 0.08);

  const beatIntervalMs = 60000 / smoothedBpm;
  if (millis() - lastBeatMs > beatIntervalMs) {
    pulseEnvelope = 1;
    lastBeatMs = millis();
  }
  pulseEnvelope *= 0.92;
}

function renderWater() {
  const bpmNorm = map(smoothedBpm, 45, 170, 0, 1, true);
  const chaos = pow(bpmNorm, 1.55);
  const waveStrength = 18 + bpmNorm * 44 + pulseEnvelope * 60;
  const lineGap = map(bpmNorm, 0, 1, 8, 5.8);
  const dx = map(chaos, 0, 1, 4.8, 2.8);
  const t = frameCount * (0.0045 + bpmNorm * 0.0055 + chaos * 0.0035);

  background(7, 29 + pulseEnvelope * 35, 44 + pulseEnvelope * 26, 255);

  strokeWeight(1.2 + chaos * 0.4);
  stroke(196, 233, 246, 155 + pulseEnvelope * 85 + chaos * 35);

  for (let yBase = -30; yBase < height + 50; yBase += lineGap) {
    const lineDrift = (noise(yBase * 0.012, t * 0.55) - 0.5) * chaos * 120;
    beginShape();
    for (let x = -30; x < width + 30; x += dx) {
      const nx = x * 0.0038;
      const ny = yBase * 0.005;
      const n1 = noise(nx + t * 0.85, ny - t * 0.5);
      const n2 = noise(nx * 1.8 - t * 0.6, ny * 1.2 + t * 0.8);
      const n3 = noise(nx * 4.4 + t * 1.3, ny * 3.7 - t * 1.1);
      const swirl = sin((x * 0.008) + phase + n2 * (4.6 + chaos * 7.5));
      const turbulence = (n3 - 0.5) * chaos * (50 + pulseEnvelope * 55);
      const yOffset = (n1 - 0.5) * waveStrength + swirl * (5 + bpmNorm * 14 + chaos * 24) + turbulence;
      curveVertex(x, yBase + yOffset + lineDrift);
    }
    endShape();
  }

  phase += 0.02 + bpmNorm * 0.018 + chaos * 0.025;
}

function keyPressed() {
  if (key === "w" || key === "W") {
    toggleSource();
  }
}

function toggleSource() {
  bpmSource = bpmSource === "simulation" ? "websocket" : "simulation";
  if (bpmSource === "websocket") {
    wsInput.connect();
  } else {
    wsInput.disconnect();
  }
  updateHud();
}

function updateHud() {
  sourceLabelEl.textContent = bpmSource;
  bpmLabelEl.textContent = `${smoothedBpm.toFixed(1)} bpm`;
  wsState = wsInput.getState();
  wsLabelEl.textContent = bpmSource === "websocket" ? wsState : "idle";
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

class HeartRateSimulator {
  constructor() {
    this.base = 72;
    this.breathPhase = random(0, TWO_PI);
    this.noiseSeed = random(0, 5000);
    this.active = false;
  }

  start() {
    this.active = true;
  }

  getValue() {
    if (!this.active) return this.base;

    this.breathPhase += 0.012;
    const breathingDrift = sin(this.breathPhase) * 7.5;
    const slowNoise = (noise(this.noiseSeed + frameCount * 0.006) - 0.5) * 14;
    const occasionalSpike = noise(this.noiseSeed + frameCount * 0.017) > 0.992 ? random(8, 18) : 0;
    const target = this.base + breathingDrift + slowNoise + occasionalSpike;
    this.base = lerp(this.base, target, 0.08);
    return this.base;
  }
}

class HeartRateWebSocket {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.latest = null;
    this.state = "disconnected";
  }

  connect() {
    if (this.socket && this.socket.readyState <= 1) return;
    this.socket = new WebSocket(this.url);
    this.state = "connecting";

    this.socket.onopen = () => {
      this.state = "connected";
    };

    this.socket.onclose = () => {
      this.state = "disconnected";
    };

    this.socket.onerror = () => {
      this.state = "error";
    };

    this.socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (typeof payload.bpm === "number") {
          this.latest = payload.bpm;
        }
      } catch (err) {
        this.state = "bad_data";
      }
    };
  }

  disconnect() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.state = "disconnected";
  }

  getValue(fallback) {
    return typeof this.latest === "number" ? this.latest : fallback;
  }

  getState() {
    return this.state;
  }
}

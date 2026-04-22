const WS_URL = "ws://localhost:8080";

let currentBpm = 140;
let smoothedBpm = 140;
let bpmSource = "simulation";
let wsState = "disconnected";
let pulseEnvelope = 0;
let lastBeatMs = 0;
let simTime = 0;
let paused = false;

let simulator;
let wsInput;
let sourceLabelEl;
let bpmLabelEl;
let wsLabelEl;
let waveShader;

const vertShader = `
precision mediump float;
attribute vec3 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;

void main() {
  vTexCoord = aTexCoord;
  gl_Position = vec4(aPosition, 1.0);
}
`;

const fragShader = `
precision mediump float;
varying vec2 vTexCoord;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_heartRate;
uniform float u_pulse;

float random(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);

  float a = random(i);
  float b = random(i + vec2(1.0, 0.0));
  float c = random(i + vec2(0.0, 1.0));
  float d = random(i + vec2(1.0, 1.0));

  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float layeredNoise(vec2 uv) {
  float n = 0.0;
  n += noise(uv * 2.0) * 0.5;
  n += noise(uv * 4.0) * 0.25;
  n += noise(uv * 8.0) * 0.125;
  n += noise(uv * 16.0) * 0.0625;
  n += noise(uv * 32.0) * 0.03125;
  return n / 0.96875;
}

float softBand(float x, float width) {
  float d = abs(fract(x) - 0.5);
  return 1.0 - smoothstep(width, width + 0.06, d);
}

vec3 paletteColor(float t) {
  // 使用用户指定调色板:
  // #8C162C #D95276 #8C4579 #8C4535 #592E25
  vec3 c0 = vec3(0.549, 0.086, 0.173);
  vec3 c1 = vec3(0.851, 0.322, 0.463);
  vec3 c2 = vec3(0.549, 0.271, 0.475);
  vec3 c3 = vec3(0.549, 0.271, 0.208);
  vec3 c4 = vec3(0.349, 0.180, 0.145);

  float x = clamp(t, 0.0, 1.0) * 4.0;
  if (x < 1.0) return mix(c0, c1, x);
  if (x < 2.0) return mix(c1, c2, x - 1.0);
  if (x < 3.0) return mix(c2, c3, x - 2.0);
  return mix(c3, c4, x - 3.0);
}

void main() {
  // screenUV 用于全屏覆盖；uv 仅用于保持纹理纵横比
  vec2 screenUV = vTexCoord * 2.0 - 1.0;
  vec2 uv = screenUV;
  uv.x *= u_resolution.x / u_resolution.y;

  float hr = clamp(u_heartRate, 0.0, 1.0);
  float t = u_time;
  // 全局降速：保留心率驱动关系，但降低基础与峰值速度
  float speed = 0.11 + hr * 0.28 + u_pulse * 0.08;
  float amp = 0.06 + hr * 0.24 + u_pulse * 0.09;

  // 流体扭曲：让阶梯条纹保持“水波”而不僵硬
  vec2 flow = vec2(
    sin(uv.y * 7.0 + t * (1.0 + hr * 2.8)) * amp +
    (layeredNoise(uv * 3.5 + vec2(0.0, t * speed)) - 0.5) * amp * 1.4,
    cos(uv.x * 6.0 - t * (0.9 + hr * 2.4)) * amp * 0.7 +
    (layeredNoise(uv * 4.2 + vec2(t * speed, 0.0)) - 0.5) * amp
  );

  // 低频 Perlin 风格噪声场：制造大尺度不规则区域，打破重复
  vec2 lowWarp = vec2(
    layeredNoise(uv * 1.1 + vec2(t * 0.06, -t * 0.04)),
    layeredNoise(uv * 1.3 + vec2(-t * 0.05, t * 0.07))
  ) - 0.5;
  vec2 midWarp = vec2(
    layeredNoise(uv * 2.4 + vec2(t * 0.12, t * 0.03)),
    layeredNoise(uv * 2.0 + vec2(-t * 0.08, -t * 0.06))
  ) - 0.5;

  vec2 p = (uv + flow + lowWarp * 0.75 + midWarp * 0.35) * (8.0 + hr * 6.0);

  // 斜向坐标，构造参考图里的大方向
  vec2 r = vec2(
    p.x * 0.95 + p.y * 0.42,
    -p.x * 0.12 + p.y * 1.03
  );

  // 关键：阶梯偏移，做出“折线台阶”纹理
  // 按区域动态改变“台阶宽度”和“台阶推进”，避免规律平铺
  float regionA = layeredNoise(r * 0.08 + vec2(7.1, -3.7));
  float regionB = layeredNoise(r * 0.12 + vec2(-5.2, 9.4));
  float stairStep = mix(0.52, 0.98, regionA);
  float stairGain = mix(0.62, 1.28, regionB) * (0.85 + hr * 0.35);
  float stair = floor((r.x + regionB * 1.6) / stairStep) * stairGain;
  float ridgeCoord = r.y + stair;

  // 多频条纹：粗条 + 细条
  float bandWarp = (layeredNoise(r * 0.18 + vec2(t * 0.22, -t * 0.1)) - 0.5) * 3.2;
  float widthJitter = (layeredNoise(r * 0.26 + vec2(-t * 0.15, t * 0.17)) - 0.5) * 0.05;
  float bandWide = softBand((ridgeCoord + bandWarp) * 0.26 + t * speed * 1.25, 0.14 - hr * 0.03 + widthJitter);
  float bandFine = softBand((ridgeCoord - bandWarp * 0.6) * 0.62 - t * speed * 2.0, 0.08 - hr * 0.015 + widthJitter * 0.6);
  float verticalEcho = softBand((r.x * 0.35 - r.y * 0.05) * 0.55, 0.11);

  // 暗横带，贴合参考图中的深色横向扫过
  float darkSweep = 1.0 - smoothstep(0.0, 0.08, abs(sin(uv.y * 7.8 + t * 0.45)));

  float regionMask = smoothstep(0.2, 0.85, layeredNoise(r * 0.07 + vec2(12.0, 2.0)));
  float structure = bandWide * (0.5 + regionMask * 0.45) + bandFine * 0.42 + verticalEcho * (0.2 + (1.0 - regionMask) * 0.35);
  structure *= 0.92 + hr * 0.45;
  structure += (layeredNoise(r * 0.3 + vec2(t * 0.2, -t * 0.12)) - 0.5) * 0.15;
  structure = clamp(structure, 0.0, 1.0);

  float colorT = clamp(structure * 0.82 + bandFine * 0.2 - darkSweep * 0.1, 0.0, 1.0);
  vec3 baseColor = paletteColor(colorT);

  // 柔焦发光感
  float glow = smoothstep(0.22, 1.0, structure) * (0.8 + hr * 0.5);
  vec3 color = baseColor * (0.35 + glow * 1.35);
  color += paletteColor(clamp(colorT + 0.2, 0.0, 1.0)) * bandFine * 0.22;
  color *= 1.0 - darkSweep * 0.35;

  // 仅保留极弱边缘衰减，避免出现明显黑边
  float edgeFade = smoothstep(1.7, 0.05, length(screenUV));
  vec3 finalColor = color * mix(1.0, edgeFade, 0.08);

  // 轻微颗粒，避免完全平滑
  finalColor += (random(uv * 210.0 + t) - 0.5) * 0.025;
  finalColor = clamp(finalColor, 0.0, 1.0);
  gl_FragColor = vec4(finalColor, 1.0);
}
`;

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  noStroke();

  sourceLabelEl = document.getElementById("sourceLabel");
  bpmLabelEl = document.getElementById("bpmLabel");
  wsLabelEl = document.getElementById("wsLabel");

  simulator = new HeartRateSimulator();
  wsInput = new HeartRateWebSocket(WS_URL);
  simulator.start();

  waveShader = createShader(vertShader, fragShader);
  updateHud();
}

function draw() {
  if (paused) return;

  updateHeartRate();
  // 降低时间推进速度，整体动画更慢更稳
  simTime += (deltaTime / 1000) * 0.58;

  shader(waveShader);
  waveShader.setUniform("u_resolution", [width, height]);
  waveShader.setUniform("u_time", simTime);
  waveShader.setUniform("u_heartRate", map(smoothedBpm, 0, 400, 0.0, 1.0, true));
  waveShader.setUniform("u_pulse", pulseEnvelope);

  beginShape();
  vertex(-1, -1, 0, 0, 1);
  vertex(1, -1, 0, 1, 1);
  vertex(1, 1, 0, 1, 0);
  vertex(-1, 1, 0, 0, 0);
  endShape(CLOSE);

  resetShader();
  updateHud();
}

function updateHeartRate() {
  const nextBpm = bpmSource === "simulation" ? simulator.getValue() : wsInput.getValue(currentBpm);
  currentBpm = constrain(nextBpm, 0, 400);
  smoothedBpm = lerp(smoothedBpm, currentBpm, 0.08);

  if (smoothedBpm >= 1) {
    const beatIntervalMs = 60000 / smoothedBpm;
    if (millis() - lastBeatMs > beatIntervalMs) {
      pulseEnvelope = 1;
      lastBeatMs = millis();
    }
  }
  pulseEnvelope *= 0.9;
}

function keyPressed() {
  if (key === "w" || key === "W") {
    toggleSource();
  } else if (key === "k" || key === "K") {
    save("water-ripple.jpg");
  } else if (key === " ") {
    paused = !paused;
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
  if (!sourceLabelEl || !bpmLabelEl || !wsLabelEl) return;
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
    this.baseA = 70;
    this.baseB = 72;
    this.breathPhaseA = random(0, TWO_PI);
    this.breathPhaseB = random(0, TWO_PI);
    this.noiseSeedA = random(0, 5000);
    this.noiseSeedB = random(5000, 10000);
    this.active = false;
  }

  start() {
    this.active = true;
  }

  getValue() {
    if (!this.active) return this.baseA + this.baseB;

    this.breathPhaseA += 0.011;
    this.breathPhaseB += 0.013;

    const driftA = sin(this.breathPhaseA) * 8.0;
    const driftB = sin(this.breathPhaseB) * 7.5;
    const noiseA = (noise(this.noiseSeedA + frameCount * 0.006) - 0.5) * 10.0;
    const noiseB = (noise(this.noiseSeedB + frameCount * 0.0055) - 0.5) * 10.0;
    const spikeA = noise(this.noiseSeedA + frameCount * 0.015) > 0.993 ? random(8, 18) : 0;
    const spikeB = noise(this.noiseSeedB + frameCount * 0.014) > 0.993 ? random(8, 18) : 0;

    const targetA = 70 + driftA + noiseA + spikeA;
    const targetB = 72 + driftB + noiseB + spikeB;
    this.baseA = lerp(this.baseA, targetA, 0.09);
    this.baseB = lerp(this.baseB, targetB, 0.09);

    return this.baseA + this.baseB;
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

    // ESP32 接入点（双传感器）：
    // 推荐 {"bpm1": 78, "bpm2": 81} 或 {"sensorA": 78, "sensorB": 81}
    // 兼容 {"bpm": 159}（已求和）
    this.socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const hasPairA = typeof payload.bpm1 === "number" && typeof payload.bpm2 === "number";
        const hasPairB = typeof payload.sensorA === "number" && typeof payload.sensorB === "number";

        if (hasPairA) {
          this.latest = payload.bpm1 + payload.bpm2;
        } else if (hasPairB) {
          this.latest = payload.sensorA + payload.sensorB;
        } else if (typeof payload.bpm === "number") {
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

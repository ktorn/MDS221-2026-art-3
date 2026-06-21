const APP_SECRETS = window.APP_SECRETS || {};
const REGISTRY_BASE_URL =
  APP_SECRETS.registryBaseUrl || "https://esp-device-registry.xxx.workers.dev";
const DEFAULT_DEVICE_ID = APP_SECRETS.deviceId || "MDS221-2026-3";

function readUrlConfig() {
  const params = new URLSearchParams(window.location.search);
  return {
    deviceId: params.get("deviceId") || DEFAULT_DEVICE_ID,
    token: params.get("token") || APP_SECRETS.registryToken || null,
    registry: params.get("registry") || REGISTRY_BASE_URL,
    ws: params.get("ws"),
    wsHost: params.get("wsHost"),
    wsPort: params.get("wsPort") || "81",
  };
}

function hasDirectWs(config) {
  return !!(config.ws || config.wsHost);
}

function needsRegistryLookup(config) {
  return !hasDirectWs(config) && !!(config.deviceId && config.token);
}

async function lookupDeviceEndpoint(config) {
  const base = config.registry.replace(/\/$/, "");
  const url = new URL(`${base}/lookup`);
  url.searchParams.set("device_id", config.deviceId);
  url.searchParams.set("token", config.token);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`lookup ${res.status}`);
  }
  const data = await res.json();
  if (!data.lan_ip) throw new Error("no lan_ip");
  const port = data.ws_port || 81;
  return `ws://${data.lan_ip}:${port}`;
}

const URL_CONFIG = readUrlConfig();
let WS_URL = hasDirectWs(URL_CONFIG)
  ? URL_CONFIG.ws || `ws://${URL_CONFIG.wsHost}:${URL_CONFIG.wsPort}`
  : "resolving…";

const RECEIVE_WINDOW = 5;
const MIN_EXPECTED_INTERVAL_MS = 150;
const RECEIVE_DEDUPE_MS = 50;

let currentBpm = 0;
let smoothedBpm = 0;
let bpmSource = "websocket";
let registryState = needsRegistryLookup(URL_CONFIG)
  ? "resolving"
  : hasDirectWs(URL_CONFIG)
    ? "bypassed"
    : "no token";
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
let wsUrlLabelEl;
let registryLabelEl;
let debugPaneEl;
let waveShader;
let debugPaneVisible = false;

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
  float speed = 0.07 + hr * 0.16 + u_pulse * 0.08;
  float amp = 0.06 + hr * 0.24 + u_pulse * 0.14;
  float pulseKick = smoothstep(0.0, 1.0, u_pulse);

  // 流体扭曲：让阶梯条纹保持“水波”而不僵硬
  vec2 flow = vec2(
    sin(uv.y * 7.0 + t * (0.65 + hr * 1.7)) * amp +
    (layeredNoise(uv * 3.5 + vec2(0.0, t * speed)) - 0.5) * amp * 1.4,
    cos(uv.x * 6.0 - t * (0.55 + hr * 1.45)) * amp * 0.7 +
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

  // 心跳脉冲：瞬时放大与轻微旋扭，制造“跳一下”的体感
  float pulseScale = 1.0 + pulseKick * (0.10 + hr * 0.06);
  float pulseTwist = pulseKick * (0.05 + hr * 0.04);
  mat2 rot = mat2(cos(pulseTwist), -sin(pulseTwist), sin(pulseTwist), cos(pulseTwist));

  vec2 p = rot * (uv + flow + lowWarp * 0.75 + midWarp * 0.35);
  p *= (8.0 + hr * 6.0) * pulseScale;

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
  float bandWide = softBand((ridgeCoord + bandWarp) * 0.26 + t * speed * 0.9, 0.14 - hr * 0.03 + widthJitter);
  float bandFine = softBand((ridgeCoord - bandWarp * 0.6) * 0.62 - t * speed * 1.35, 0.08 - hr * 0.015 + widthJitter * 0.6);
  float verticalEcho = softBand((r.x * 0.35 - r.y * 0.05) * 0.55, 0.11);

  // 去除明显水平扫带，改为更自然的区域明暗起伏
  float tonalNoise = layeredNoise(r * 0.11 + vec2(t * 0.06, -t * 0.04));
  float darkSweep = smoothstep(0.15, 0.9, tonalNoise);

  float regionMask = smoothstep(0.2, 0.85, layeredNoise(r * 0.07 + vec2(12.0, 2.0)));
  float structure = bandWide * (0.5 + regionMask * 0.45) + bandFine * 0.42 + verticalEcho * (0.2 + (1.0 - regionMask) * 0.35);
  structure *= 0.92 + hr * 0.45;
  structure += (layeredNoise(r * 0.3 + vec2(t * 0.2, -t * 0.12)) - 0.5) * 0.15;
  structure += pulseKick * 0.11;
  structure = clamp(structure, 0.0, 1.0);

  float colorT = clamp(structure * 0.82 + bandFine * 0.2 - (1.0 - darkSweep) * 0.08, 0.0, 1.0);
  vec3 baseColor = paletteColor(colorT);

  // 柔焦发光感
  float glow = smoothstep(0.22, 1.0, structure) * (0.95 + hr * 0.6 + pulseKick * 0.55);
  vec3 color = baseColor * (0.48 + glow * 1.52);
  color += paletteColor(clamp(colorT + 0.2, 0.0, 1.0)) * bandFine * 0.3;
  color *= 0.78 + darkSweep * 0.22;

  // 亮度随合并心率变化：低心率更暗，高心率更亮
  float brightness = mix(0.52, 1.28, hr) + pulseKick * 0.16;
  float gammaLift = mix(1.22, 0.86, hr);
  color = pow(color, vec3(gammaLift)) * brightness;

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

  createDebugPane();
  sourceLabelEl = document.getElementById("sourceLabel");
  bpmLabelEl = document.getElementById("bpmLabel");
  wsLabelEl = document.getElementById("wsLabel");
  wsUrlLabelEl = document.getElementById("wsUrlLabel");
  registryLabelEl = document.getElementById("registryLabel");
  debugPaneEl = document.getElementById("debugPane");

  simulator = new HeartRateSimulator();
  wsInput = new HeartRateWebSocket(WS_URL);
  simulator.start();

  if (needsRegistryLookup(URL_CONFIG)) {
    lookupDeviceEndpoint(URL_CONFIG)
      .then((url) => {
        WS_URL = url;
        wsInput.setUrl(url);
        wsInput.connect();
        registryState = "ok";
        updateHud();
      })
      .catch((err) => {
        registryState = err.message || "failed";
        updateHud();
      });
  } else if (hasDirectWs(URL_CONFIG)) {
    wsInput.connect();
  }

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
  let nextBpm;
  if (bpmSource === "simulation") {
    const simulated = simulator.getValue();
    const mouseControlled = map(mouseX, 0, width, 0, 400, true);
    // 在 simulation 模式下，按住鼠标可手动控制心率
    nextBpm = mouseIsPressed ? mouseControlled : simulated;
  } else {
    nextBpm = wsInput.getValue();
  }

  currentBpm = constrain(nextBpm, 0, 400);
  if (bpmSource === "websocket") {
    smoothedBpm = currentBpm;
  } else {
    const smoothFactor = currentBpm === 0 ? 0.25 : 0.08;
    smoothedBpm = lerp(smoothedBpm, currentBpm, smoothFactor);
  }

  if (smoothedBpm >= 1) {
    const beatIntervalMs = 60000 / smoothedBpm;
    if (millis() - lastBeatMs > beatIntervalMs) {
      pulseEnvelope = 1;
      lastBeatMs = millis();
    }
  }
  // 稍慢衰减，让脉冲动作更可见
  pulseEnvelope *= 0.93;
}

function keyPressed() {
  if (key === "w" || key === "W") {
    toggleSource();
  } else if (key === "k" || key === "K") {
    save("water-ripple.jpg");
  } else if (key === "d" || key === "D") {
    toggleDebugPane();
  } else if (key === " ") {
    paused = !paused;
  }
}

function toggleDebugPane() {
  if (!debugPaneEl) return;
  debugPaneVisible = !debugPaneVisible;
  debugPaneEl.style.display = debugPaneVisible ? "block" : "none";
}

function createDebugPane() {
  const existing = document.getElementById("debugPane");
  if (existing) existing.remove();

  const pane = document.createElement("div");
  pane.id = "debugPane";
  pane.style.position = "fixed";
  pane.style.top = "10px";
  pane.style.left = "10px";
  pane.style.zIndex = "9999";
  pane.style.padding = "10px";
  pane.style.borderRadius = "8px";
  pane.style.background = "rgba(0, 0, 0, 0.55)";
  pane.style.color = "#f2d7dc";
  pane.style.fontFamily = "Arial, sans-serif";
  pane.style.fontSize = "14px";
  pane.style.lineHeight = "1.4";
  pane.style.pointerEvents = "none";
  pane.innerHTML = `
    <div>Source: <strong id="sourceLabel">simulation</strong></div>
    <div>BPM: <strong id="bpmLabel">--</strong></div>
    <div>WS: <strong id="wsLabel">disconnected</strong></div>
    <div>Endpoint: <strong id="wsUrlLabel">--</strong></div>
    <div>Registry: <strong id="registryLabel">idle</strong></div>
    <div style="margin-top:6px; font-size:12px; opacity:0.85;">
      W: source | K: save | Space: pause | D: debug
    </div>
    <div style="font-size:11px; opacity:0.75;">
      Override: ?wsHost=&lt;ip&gt; | W: simulation
    </div>
  `;
  pane.style.display = debugPaneVisible ? "block" : "none";
  document.body.appendChild(pane);
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
  bpmLabelEl.textContent = `${Math.round(currentBpm)} bpm`;
  wsState = wsInput.getState();
  wsLabelEl.textContent = bpmSource === "websocket" ? wsState : "idle";
  if (wsUrlLabelEl) wsUrlLabelEl.textContent = WS_URL;
  if (registryLabelEl) registryLabelEl.textContent = registryState;
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

    const drift = sin(this.breathPhase) * 7.0;
    const noiseVal = (noise(this.noiseSeed + frameCount * 0.006) - 0.5) * 10.0;
    const spike = noise(this.noiseSeed + frameCount * 0.015) > 0.993 ? random(8, 18) : 0;

    const target = 72 + drift + noiseVal + spike;
    this.base = lerp(this.base, target, 0.09);

    return this.base;
  }
}

class HeartRateWebSocket {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.latest = null;
    this.lastReceivedMs = 0;
    this.receiveTimes = [];
    this.state = "disconnected";
    this.wantConnection = false;
    this.reconnectTimer = null;
  }

  setUrl(url) {
    const wasConnected = this.wantConnection;
    this.disconnect();
    this.url = url;
    if (wasConnected) this.connect();
  }

  connect() {
    this.wantConnection = true;
    this.openSocket();
  }

  openSocket() {
    if (this.socket && this.socket.readyState <= 1) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.socket = new WebSocket(this.url);
    this.state = "connecting";

    this.socket.onopen = () => {
      this.state = "connected";
    };
    this.socket.onclose = () => {
      this.state = "disconnected";
      this.socket = null;
      if (this.wantConnection) {
        this.reconnectTimer = setTimeout(() => this.openSocket(), 2000);
      }
    };
    this.socket.onerror = () => {
      this.state = "error";
    };

    // ESP32 single sensor: {"bpm": 72, "source": "esp32", "ts": 123456789}
    this.socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (typeof payload.bpm !== "number") return;
        this.noteReceive();
        this.latest = payload.bpm > 0 ? Math.round(payload.bpm) : 0;
      } catch (err) {
        this.state = "bad_data";
      }
    };
  }

  disconnect() {
    this.wantConnection = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.latest = null;
    this.lastReceivedMs = 0;
    this.receiveTimes = [];
    this.state = "disconnected";
  }

  noteReceive() {
    const now = Date.now();
    this.lastReceivedMs = now;
    const last = this.receiveTimes[this.receiveTimes.length - 1];
    if (last !== undefined && now - last < RECEIVE_DEDUPE_MS) return;
    this.receiveTimes.push(now);
    if (this.receiveTimes.length > RECEIVE_WINDOW) {
      this.receiveTimes.shift();
    }
  }

  averageIntervalMs() {
    if (this.receiveTimes.length < 2) return MIN_EXPECTED_INTERVAL_MS;
    let sum = 0;
    let count = 0;
    for (let i = 1; i < this.receiveTimes.length; i++) {
      const delta = this.receiveTimes[i] - this.receiveTimes[i - 1];
      if (delta < RECEIVE_DEDUPE_MS) continue;
      sum += delta;
      count++;
    }
    if (count === 0) return MIN_EXPECTED_INTERVAL_MS;
    return sum / count;
  }

  isStale() {
    if (this.lastReceivedMs === 0) return true;
    return Date.now() - this.lastReceivedMs > this.averageIntervalMs();
  }

  getValue() {
    if (this.isStale()) return 0;
    return typeof this.latest === "number" ? this.latest : 0;
  }

  getState() {
    return this.state;
  }
}

"use strict";

const creator = new URLSearchParams(window.location.search).get("creator");
const viewer = new URLSearchParams(window.location.search).get("viewer");

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
  vec2 screenUV = vTexCoord * 2.0 - 1.0;
  vec2 uv = screenUV;
  uv.x *= u_resolution.x / u_resolution.y;

  float hr = clamp(u_heartRate, 0.0, 1.0);
  float t = u_time;
  float speed = 0.07 + hr * 0.16 + u_pulse * 0.08;
  float amp = 0.06 + hr * 0.24 + u_pulse * 0.14;
  float pulseKick = smoothstep(0.0, 1.0, u_pulse);

  vec2 flow = vec2(
    sin(uv.y * 7.0 + t * (0.65 + hr * 1.7)) * amp +
    (layeredNoise(uv * 3.5 + vec2(0.0, t * speed)) - 0.5) * amp * 1.4,
    cos(uv.x * 6.0 - t * (0.55 + hr * 1.45)) * amp * 0.7 +
    (layeredNoise(uv * 4.2 + vec2(t * speed, 0.0)) - 0.5) * amp
  );

  vec2 lowWarp = vec2(
    layeredNoise(uv * 1.1 + vec2(t * 0.06, -t * 0.04)),
    layeredNoise(uv * 1.3 + vec2(-t * 0.05, t * 0.07))
  ) - 0.5;
  vec2 midWarp = vec2(
    layeredNoise(uv * 2.4 + vec2(t * 0.12, t * 0.03)),
    layeredNoise(uv * 2.0 + vec2(-t * 0.08, -t * 0.06))
  ) - 0.5;

  float pulseScale = 1.0 + pulseKick * (0.10 + hr * 0.06);
  float pulseTwist = pulseKick * (0.05 + hr * 0.04);
  mat2 rot = mat2(cos(pulseTwist), -sin(pulseTwist), sin(pulseTwist), cos(pulseTwist));

  vec2 p = rot * (uv + flow + lowWarp * 0.75 + midWarp * 0.35);
  p *= (8.0 + hr * 6.0) * pulseScale;

  vec2 r = vec2(
    p.x * 0.95 + p.y * 0.42,
    -p.x * 0.12 + p.y * 1.03
  );

  float regionA = layeredNoise(r * 0.08 + vec2(7.1, -3.7));
  float regionB = layeredNoise(r * 0.12 + vec2(-5.2, 9.4));
  float stairStep = mix(0.52, 0.98, regionA);
  float stairGain = mix(0.62, 1.28, regionB) * (0.85 + hr * 0.35);
  float stair = floor((r.x + regionB * 1.6) / stairStep) * stairGain;
  float ridgeCoord = r.y + stair;

  float bandWarp = (layeredNoise(r * 0.18 + vec2(t * 0.22, -t * 0.1)) - 0.5) * 3.2;
  float widthJitter = (layeredNoise(r * 0.26 + vec2(-t * 0.15, t * 0.17)) - 0.5) * 0.05;
  float bandWide = softBand((ridgeCoord + bandWarp) * 0.26 + t * speed * 0.9, 0.14 - hr * 0.03 + widthJitter);
  float bandFine = softBand((ridgeCoord - bandWarp * 0.6) * 0.62 - t * speed * 1.35, 0.08 - hr * 0.015 + widthJitter * 0.6);
  float verticalEcho = softBand((r.x * 0.35 - r.y * 0.05) * 0.55, 0.11);

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

  float glow = smoothstep(0.22, 1.0, structure) * (0.95 + hr * 0.6 + pulseKick * 0.55);
  vec3 color = baseColor * (0.48 + glow * 1.52);
  color += paletteColor(clamp(colorT + 0.2, 0.0, 1.0)) * bandFine * 0.3;
  color *= 0.78 + darkSweep * 0.22;

  float brightness = mix(0.52, 1.28, hr) + pulseKick * 0.16;
  float gammaLift = mix(1.22, 0.86, hr);
  color = pow(color, vec3(gammaLift)) * brightness;

  float edgeFade = smoothstep(1.7, 0.05, length(screenUV));
  vec3 finalColor = color * mix(1.0, edgeFade, 0.08);

  finalColor += (random(uv * 210.0 + t) - 0.5) * 0.025;
  finalColor = clamp(finalColor, 0.0, 1.0);
  gl_FragColor = vec4(finalColor, 1.0);
}
`;

let currentBpm = 72;
let smoothedBpm = 72;
let pulseEnvelope = 0;
let lastBeatMs = 0;
let simTime = 0;
let paused = false;
let simulator;
let waveShader;

function setup() {
  pixelDensity(1);
  createCanvas(windowWidth, windowHeight, WEBGL);
  noStroke();
  simulator = new HeartRateSimulator();
  simulator.start();
  waveShader = createShader(vertShader, fragShader);
}

function draw() {
  if (paused) return;

  updateHeartRate();
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
}

function pointerX() {
  if (touches.length > 0) return touches[0].x;
  return mouseX;
}

function pointerPressed() {
  return mouseIsPressed || touches.length > 0;
}

function updateHeartRate() {
  const simulated = simulator.getValue();
  const pointerControlled = map(pointerX(), 0, width, 0, 400, true);
  const nextBpm = pointerPressed() ? pointerControlled : simulated;

  currentBpm = constrain(nextBpm, 0, 400);
  const smoothFactor = currentBpm === 0 ? 0.25 : 0.08;
  smoothedBpm = lerp(smoothedBpm, currentBpm, smoothFactor);

  if (smoothedBpm >= 1) {
    const beatIntervalMs = 60000 / smoothedBpm;
    if (millis() - lastBeatMs > beatIntervalMs) {
      pulseEnvelope = 1;
      lastBeatMs = millis();
    }
  }
  pulseEnvelope *= 0.93;
}

function keyPressed() {
  if (key === "k" || key === "K") {
    save("heart-wave.jpg");
  } else if (key === " ") {
    paused = !paused;
  }
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

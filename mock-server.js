const { WebSocketServer } = require("ws");

const port = 8080;
const wss = new WebSocketServer({ port });

console.log(`Mock heart-rate WebSocket on ws://localhost:${port}`);

function generateBpm(tick) {
  const baseline = 74;
  const breathing = Math.sin(tick * 0.08) * 6;
  const variability = (Math.random() - 0.5) * 5;
  const rarePeak = Math.random() > 0.985 ? 14 + Math.random() * 10 : 0;
  return Math.max(48, Math.min(168, baseline + breathing + variability + rarePeak));
}

wss.on("connection", (socket) => {
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const bpm = Number(generateBpm(tick).toFixed(1));
    socket.send(
      JSON.stringify({
        bpm,
        source: "mock-server",
        ts: Date.now(),
      }),
    );
  }, 200);

  socket.on("close", () => {
    clearInterval(timer);
  });
});

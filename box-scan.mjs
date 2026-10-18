import { decodePngGray, regionStats } from "./scripts/lib/png.mjs";
const png = decodePngGray("./.dsh-tmp/shots/canvas-glow.png");
const boxes = [
  { name: "right-mid", left: 240 + 1176 - 400, top: 260, width: 240, height: 120 },
  { name: "right-mid2", left: 240 + 1176 - 400, top: 240, width: 240, height: 120 },
  { name: "bottom-mid", left: 240 + 1176 - 470, top: 640, width: 200, height: 110 },
];
for (const box of boxes) {
  const s = regionStats(png, box);
  console.log(box.name, JSON.stringify(box), "max", s.max, "p99", s.p99);
}

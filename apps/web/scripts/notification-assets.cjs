// Run with SHARP_PATH pointing at an installed sharp package directory.
const fs = require("node:fs");
const sharp = require(process.env.SHARP_PATH);
(async () => {
  const ico = fs.readFileSync("apps/web/public/favicon.ico");
  const offset = ico.readUInt32LE(50);
  const icon = ico.subarray(offset, offset + ico.readUInt32LE(46));
  const frames = [];
  for (let i = 0; i < 100; i++) {
    const mark = await sharp(icon)
      .rotate(i * 14.4, { background: "#f0f0f000" })
      .png()
      .toBuffer();
    const meta = await sharp(mark).metadata();
    const x = Math.round(i * 5);
    frames.push(
      await sharp({
        create: { width: 600, height: 72, channels: 4, background: "#f0f0f0" },
      })
        .composite([
          { input: mark, left: x, top: Math.round((72 - meta.height) / 2) },
        ])
        .extract({ left: 70, top: 0, width: 360, height: 72 })
        .raw()
        .toBuffer(),
    );
  }
  await sharp(Buffer.concat(frames), {
    raw: { width: 360, height: 7200, channels: 4, pageHeight: 72 },
  })
    .gif({
      loop: 0,
      delay: Array(100).fill(40),
      colours: 64,
      keepDuplicateFrames: true,
    })
    .toFile("apps/web/public/assets/tailos-rolling-v1.gif");
  for (const [state, color] of [
    ["succeeded", "#128348"],
    ["failed", "#c63838"],
  ]) {
    const badge = Buffer.from(
      `<svg width="360" height="72"><rect y="68" width="360" height="4" fill="${color}"/><circle cx="224" cy="36" r="10" fill="${color}"/></svg>`,
    );
    await sharp({
      create: { width: 360, height: 72, channels: 4, background: "#f0f0f0" },
    })
      .composite([{ input: icon, left: 156, top: 12 }, { input: badge }])
      .png()
      .toFile(`apps/web/public/assets/tailos-${state}-v1.png`);
  }
  // oxlint-disable-next-line no-console -- asset metadata only
  console.log(
    await sharp("apps/web/public/assets/tailos-rolling-v1.gif", {
      animated: true,
    }).metadata(),
  );
})();

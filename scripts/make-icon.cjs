// Builds build/icon.png (512×512, the OneRoot logo centred on white) from the frontend's logo.
// Uses the frontend's copy of sharp so this project needs no image library of its own.
const path = require('path');
const sharp = require(path.join(__dirname, '..', '..', 'oneroot-ERP-frontend', 'node_modules', 'sharp'));
const logo = path.join(__dirname, '..', '..', 'oneroot-ERP-frontend', 'public', 'logo-vertical.png');
(async () => {
  const inner = await sharp(logo).resize(440, 440, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).toBuffer();
  await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: inner, gravity: 'center' }])
    .png()
    .toFile(path.join(__dirname, '..', 'build', 'icon.png'));
  console.log('build/icon.png written');
})();

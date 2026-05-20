const fs = require('fs');
const path = require('path');

const { createCanvas, ImageData } = require('@napi-rs/canvas');
const { convertWmfToDataUrl } = require('emf-converter');

const samplePath = path.resolve(__dirname, '../map-aabb/public/generated-rectangle.wmf');
const outputPath = path.resolve(
  __dirname,
  '../map-aabb/public/generated-rectangle.from-converter.png',
);

const prototypeCanvas = createCanvas(1, 1);

global.ImageData = ImageData;
global.HTMLCanvasElement = prototypeCanvas.constructor;
global.document = {
  createElement(tagName) {
    if (tagName !== 'canvas') {
      throw new Error(`Unsupported element: ${tagName}`);
    }

    return createCanvas(1, 1);
  },
};

async function main() {
  const buffer = fs.readFileSync(samplePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const dataUrl = await convertWmfToDataUrl(arrayBuffer, 512, 512);

  if (!dataUrl) {
    throw new Error('convertWmfToDataUrl returned null');
  }

  const pngBuffer = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  fs.writeFileSync(outputPath, pngBuffer);

  console.log('ok');
  console.log(`wmf=${samplePath}`);
  console.log(`wmfBytes=${buffer.length}`);
  console.log(`png=${outputPath}`);
  console.log(`pngBytes=${pngBuffer.length}`);
  console.log(`dataUrlPrefix=${dataUrl.slice(0, 48)}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
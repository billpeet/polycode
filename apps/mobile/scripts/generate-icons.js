#!/usr/bin/env node
/**
 * Generates the mobile app icon set from the desktop PolyCode icon SVG.
 * Run from anywhere: node apps/mobile/scripts/generate-icons.js
 * (sharp comes from the desktop workspace's devDependencies)
 */
const path = require('path')
const fs = require('fs')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const svgPath = path.join(repoRoot, 'apps', 'desktop', 'resources', 'icon.svg')
const outDir = path.join(repoRoot, 'apps', 'mobile', 'assets', 'images')
const sharp = require(require.resolve('sharp', { paths: [path.join(repoRoot, 'apps', 'desktop')] }))

const BG = '#0d1117'
const SIZE = 1024

async function renderSvg(size) {
  return sharp(svgPath, { density: 72 * (size / 256) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
}

/** Center a rendered logo on a transparent (or solid) canvas. */
async function onCanvas(logoSize, background) {
  const logo = await renderSvg(logoSize)
  return sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background },
  })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toBuffer()
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 }

  // Main app icon: logo on brand background, slight padding.
  const icon = await onCanvas(880, BG)
  await sharp(icon).toFile(path.join(outDir, 'icon.png'))

  // Adaptive foreground: logo within the ~66% safe zone on transparency.
  const foreground = await onCanvas(600, transparent)
  await sharp(foreground).toFile(path.join(outDir, 'android-icon-foreground.png'))

  // Adaptive background: solid brand color.
  await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: BG } })
    .png()
    .toFile(path.join(outDir, 'android-icon-background.png'))

  // Monochrome: white shape carried by the logo's alpha (Android tints it).
  const alpha = await sharp(foreground).ensureAlpha().extractChannel('alpha').toBuffer()
  await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: '#ffffff' } })
    .joinChannel(alpha)
    .png()
    .toFile(path.join(outDir, 'android-icon-monochrome.png'))

  // Splash icon (shown small on brand background) + web favicon.
  await sharp(await renderSvg(512)).toFile(path.join(outDir, 'splash-icon.png'))
  await sharp(await renderSvg(64)).toFile(path.join(outDir, 'favicon.png'))

  console.log('icons written to', outDir)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

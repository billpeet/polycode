const sharp = require('sharp')
const { execSync } = require('child_process')
const path = require('path')

const resourcesDir = path.join(__dirname, '../resources')
const svgPath = path.join(resourcesDir, 'icon.svg')
const pngPath = path.join(resourcesDir, 'icon.png')
const icoPath = path.join(resourcesDir, 'icon.ico')

async function build() {
  // Convert SVG to PNG (256x256 for ICO)
  await sharp(svgPath)
    .resize(256, 256)
    .png()
    .toFile(pngPath)

  console.log('Created icon.png')

  // Convert PNG to ICO using CLI
  execSync(`npx png-to-ico "${pngPath}" > "${icoPath}"`, { shell: true })

  console.log('Created icon.ico')
}

build().catch(console.error)

# Makes the macOS app icon from build/logo.png (square, edge to edge): Apple's grid
# (artwork 824px on a 1024px transparent canvas), rounded corners and a soft shadow,
# then build/icon.png and build/icon.icns, plus the small logo the app shows.
#
#   python3 scripts/make-icon.py      (needs Pillow; iconutil and sips come with macOS)

import os, shutil, subprocess, tempfile
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(HERE, 'build')
CANVAS, ART, RADIUS = 1024, 824, 185

logo = Image.open(os.path.join(BUILD, 'logo.png')).convert('RGBA')

art = logo.resize((ART, ART), Image.LANCZOS)
mask = Image.new('L', (ART, ART), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, ART - 1, ART - 1), RADIUS, fill=255)
art.putalpha(mask)

offset = (CANVAS - ART) // 2
shadow = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
shape = Image.new('L', (CANVAS, CANVAS), 0)
ImageDraw.Draw(shape).rounded_rectangle((offset, offset + 12, offset + ART - 1, offset + ART + 11), RADIUS, fill=90)
shadow.putalpha(shape.filter(ImageFilter.GaussianBlur(14)))

icon = Image.alpha_composite(shadow, Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0)))
icon.alpha_composite(art, (offset, offset))
icon.save(os.path.join(BUILD, 'icon.png'))

iconset = os.path.join(tempfile.mkdtemp(), 'icon.iconset')
os.makedirs(iconset)
for size in (16, 32, 128, 256, 512):
    icon.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, f'icon_{size}x{size}.png'))
    icon.resize((size * 2, size * 2), Image.LANCZOS).save(os.path.join(iconset, f'icon_{size}x{size}@2x.png'))
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(BUILD, 'icon.icns')], check=True)
shutil.rmtree(os.path.dirname(iconset))

# The app's own copy: the square artwork, small (the sidebar rounds its corners).
logo.resize((128, 128), Image.LANCZOS).save(os.path.join(HERE, 'src', 'renderer', 'assets', 'logo.png'), optimize=True)
print('Wrote build/icon.png, build/icon.icns and src/renderer/assets/logo.png')

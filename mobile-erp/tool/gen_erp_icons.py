# LorkERP launcher icons and in-app logo, drawn here (no source image):
# a ledger with rising bars on the app's green, so it is not mistaken for
# «المدقق» on the phone.
# Usage: python3 tool/gen_erp_icons.py   (writes android res, assets/brand/logo.png, docs/brand)
import os
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), '..')
RES = os.path.join(ROOT, 'android/app/src/main/res')
DARK, LIGHT = (0x0b, 0x4d, 0x3c), (0x2f, 0x9a, 0x74)
S = 4  # supersampling

def gradient(size):
    img = Image.new('RGB', (size, size)); px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + (size - 1 - y)) / (2 * (size - 1))
            px[x, y] = tuple(round(DARK[i] + (LIGHT[i] - DARK[i]) * t) for i in range(3))
    return img

def glyph(size, scale=1.0, color=(255, 255, 255, 255)):
    """The mark in a 108-unit adaptive canvas (safe zone ~66 units)."""
    n = size * S
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    u = n / 108 * scale; o = n / 2 - 54 * u
    P = lambda x, y: (o + x * u, o + y * u)
    w = 4.6 * u
    # The book: cover and spine.
    d.rounded_rectangle([P(31, 29), P(77, 79)], radius=7 * u, outline=color, width=round(w))
    d.line([P(39.5, 31), P(39.5, 77)], fill=color, width=round(w * 0.8))
    # Rising bars on the page.
    for x, top in ((45.5, 60), (54.5, 51), (63.5, 41)):
        d.rounded_rectangle([P(x, top), P(x + 6, 70)], radius=1.6 * u, fill=color)
    return img.resize((size, size), Image.LANCZOS)

def rounded(img, radius_ratio):
    s = img.size[0]
    m = Image.new('L', (s * S, s * S), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, s * S - 1, s * S - 1], radius=s * S * radius_ratio, fill=255)
    out = img.convert('RGBA'); out.putalpha(m.resize((s, s), Image.LANCZOS)); return out

def full(size, scale):
    f = gradient(size).convert('RGBA'); f.alpha_composite(glyph(size, scale)); return f

dens = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for dname, k in dens.items():
    folder = f'{RES}/mipmap-{dname}'; os.makedirs(folder, exist_ok=True)
    legacy = round(48 * k)
    rounded(full(legacy, 1.3), 0.22).save(f'{folder}/ic_launcher.png', optimize=True)
    circ = full(legacy, 1.3)
    m = Image.new('L', (legacy * S, legacy * S), 0)
    ImageDraw.Draw(m).ellipse([0, 0, legacy * S - 1, legacy * S - 1], fill=255)
    circ.putalpha(m.resize((legacy, legacy), Image.LANCZOS))
    circ.save(f'{folder}/ic_launcher_round.png', optimize=True)
    fg = round(108 * k)
    glyph(fg).save(f'{folder}/ic_launcher_foreground.png', optimize=True)
    glyph(fg).save(f'{folder}/ic_launcher_monochrome.png', optimize=True)

with open(f'{RES}/drawable/ic_launcher_background.xml', 'w') as fh:
    fh.write('''<?xml version="1.0" encoding="utf-8"?>
<!-- LorkERP: dark green bottom-left to light green top-right (tool/gen_erp_icons.py). -->
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <gradient
        android:angle="45"
        android:startColor="#0B4D3C"
        android:endColor="#2F9A74"
        android:type="linear" />
</shape>
''')

rounded(full(256, 1.3), 0.24).save(os.path.join(ROOT, 'assets/brand/logo.png'), optimize=True)
brand = os.path.join(ROOT, 'docs/brand'); os.makedirs(brand, exist_ok=True)
rounded(full(1024, 1.3), 0.22).save(f'{brand}/icon-1024.png', optimize=True)
full(512, 1.3).convert('RGB').save(f'{brand}/play-store-512.png', optimize=True)
glyph(1024, 1.5, (0x0b, 0x4d, 0x3c, 255)).save(f'{brand}/logo-mark-1024.png', optimize=True)
glyph(1024, 1.5).save(f'{brand}/logo-monochrome-1024.png', optimize=True)
gradient(512).save(f'{brand}/background-gradient-512.png', optimize=True)
print('ok')

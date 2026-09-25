# Dig Wars emblem: an io Basic tank (round body, one barrel) carrying an
# emerald cut exactly like the game draws it (GEM_CUT in app.js). Writes public/img/logo.svg (used on the homepage and as the favicon).
# Run: python3 scripts/make-logo.py
import math, os

INK = '#15181d'
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'img', 'logo.svg')

def pts(p):
    return ' '.join(f'{x:.1f},{y:.1f}' for x, y in p)

def rot(p, a, cx, cy):
    ca, sa = math.cos(a), math.sin(a)
    return [(cx + (x - cx) * ca - (y - cy) * sa, cy + (x - cx) * sa + (y - cy) * ca) for x, y in p]

GEM_CUT = [(-1, -0.38), (-0.55, -0.95), (0.55, -0.95), (1, -0.38), (0, 0.95)]

def build(body=('#5dd6ff', '#0a8fd1')):
    cx, cy, R = 42, 58, 27          # round tank body
    a = math.radians(-40)           # barrel points up and right
    sw = 5.5
    RIM = '#ffffff'                 # sticker edge: keeps the shape bright on dark pages
    # Basic barrel: 0.8 of the body radius wide, 1.8 radii from the centre
    bw, bl = R * .8, R * 1.8
    barrel = rot([(cx, cy - bw / 2), (cx + bl, cy - bw / 2), (cx + bl, cy + bw / 2), (cx, cy + bw / 2)], a, cx, cy)
    g = []
    g.append(f'<polygon points="{pts(barrel)}" fill="{RIM}" stroke="{RIM}" stroke-width="{sw + 8}" stroke-linejoin="round"/>')
    g.append(f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="{RIM}" stroke="{RIM}" stroke-width="{sw + 8}"/>')
    g.append(f'<polygon points="{pts(barrel)}" fill="url(#steel)" stroke="{INK}" stroke-width="{sw}" stroke-linejoin="round"/>')
    g.append(f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="url(#bd)" stroke="{INK}" stroke-width="{sw}"/>')
    # the emerald, as the game draws a loose one: the cut, a darker rim, a
    # smaller lighter facet toward the crown, a sparkle, tilted 12 degrees
    gs, tilt = R * .6, math.radians(12)
    gcx, gcy = cx + 1, cy + 1
    def cut(scale, dy=0.0):
        return rot([(gcx + x * gs * scale, gcy + (y + dy) * gs * scale) for x, y in GEM_CUT], tilt, gcx, gcy)
    g.append(f'<polygon points="{pts(cut(1))}" fill="#1fbf6b" stroke="#0d6b3a" stroke-width="3.2" stroke-linejoin="round"/>')
    g.append(f'<polygon points="{pts(rot([(gcx + x * gs * .525, gcy + (y * .525 - .12) * gs) for x, y in GEM_CUT], tilt, gcx, gcy))}" fill="#6ff5a8"/>')
    spx, spy = rot([(gcx - gs * .405, gcy - gs * .5)], tilt, gcx, gcy)[0]
    star = [(spx + (5.5 if j % 2 == 0 else 1.4) * math.cos(j * math.pi / 4 - math.pi / 2), spy + (5.5 if j % 2 == 0 else 1.4) * math.sin(j * math.pi / 4 - math.pi / 2)) for j in range(8)]
    g.append(f'<polygon points="{pts(star)}" fill="#ffffff"/>')
    # a highlight on the hull, like the lit side of a tank
    g.append(f'<path d="M{cx - R * .7:.1f} {cy - R * .05:.1f} A{R * .7:.1f} {R * .7:.1f} 0 0 1 {cx - R * .05:.1f} {cy - R * .7:.1f}" fill="none" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" opacity=".45"/>')
    return '\n'.join([
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">',
        '<title>Corez</title>',
        '<defs>',
        f'<linearGradient id="bd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{body[0]}"/><stop offset="1" stop-color="{body[1]}"/></linearGradient>',
        '<linearGradient id="steel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f1f3f6"/><stop offset="1" stop-color="#a7adb6"/></linearGradient>',
        '</defs>',
        *g,
        '</svg>',
    ])

if __name__ == '__main__' and os.environ.get('LOGO_VARIANTS'):
    for name, body in [('blue', ('#5dd6ff', '#0a8fd1')), ('green', ('#45e88a', '#0f9a4f')), ('gold', ('#ffe07a', '#f08a24'))]:
        open(os.environ['LOGO_VARIANTS'] + '/logo_' + name + '.svg', 'w').write(build(body))
    raise SystemExit
open(OUT, 'w').write(build())
print('wrote', os.path.normpath(OUT))

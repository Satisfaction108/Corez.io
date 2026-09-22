import math, sys
sys.path.insert(0, '.')
from ttf2path import text_path
FONT = '/Users/raghavan/Documents/GitHub/Arras2/public/fonts/Ubuntu-Bold.ttf'
OUT = sys.argv[1] if len(sys.argv) > 1 else '.'

INK = '#1b1510'          # the game's thick dark outline
ROCK = ['#7a746c', '#6b6660', '#5d5852', '#827b72', '#66615a']
EMERALD, EM_LIGHT, EM_DARK = '#35c26b', '#9ff0bf', '#1d8a47'
TANK, BARREL = '#00b2e1', '#a3a3a3'

def poly(pts):
    return ' '.join(f'{x:.1f},{y:.1f}' for x, y in pts)

def emblem(ox, oy, S, detail=True):
    """A tank blasting a boulder apart, an emerald flying out of it. Drawn in
    a 100x100 box at (ox, oy), scaled to S."""
    k = S / 100.0
    T = lambda x, y: (ox + x * k, oy + y * k)
    P = lambda pts: poly([T(*p) for p in pts])
    sw = 4.4 * k
    g = []
    # boulder, top right: voronoi-style cells sharing edges, like the game's rock
    cells = [
        [(50, 8), (72, 4), (76, 20), (60, 28), (48, 22)],
        [(72, 4), (92, 12), (96, 30), (80, 34), (76, 20)],
        [(48, 22), (60, 28), (62, 44), (46, 44), (42, 32)],
        [(80, 34), (96, 30), (94, 50), (78, 50)],
    ]
    outline = [(50, 8), (72, 4), (92, 12), (96, 30), (94, 50), (78, 50), (62, 44), (46, 44), (42, 32), (48, 22)]
    g.append(f'<polygon points="{poly([T(x + 2, y + 4) for x, y in outline])}" fill="#000" opacity=".35"/>')
    for i, c in enumerate(cells):
        g.append(f'<polygon points="{P(c)}" fill="{ROCK[i % len(ROCK)]}" stroke="{INK}" stroke-width="{sw * .7:.1f}" stroke-linejoin="round"/>')
    # the blasted-out cell: a dark hole where the gem came from
    hole = [(60, 28), (76, 20), (80, 34), (78, 50), (62, 44)]
    g.append(f'<polygon points="{P(hole)}" fill="#2a2420" stroke="{INK}" stroke-width="{sw * .7:.1f}" stroke-linejoin="round"/>')
    g.append(f'<polygon points="{P(outline)}" fill="none" stroke="{INK}" stroke-width="{sw:.1f}" stroke-linejoin="round"/>')
    if detail:
        for (x, y, r, col) in [(85, 20, 4, '#eda766'), (54, 16, 3.4, '#3f86d2'), (88, 41, 3.2, '#b04fe0')]:
            g.append(f'<polygon points="{P([(x + r * math.cos(a), y + r * math.sin(a)) for a in [j * math.pi / 3 + .3 for j in range(6)]])}" fill="{col}" stroke="{INK}" stroke-width="{sw * .4:.1f}"/>')
    # shards flying off
    shards = [[(40, 50), (46, 47), (44, 55)], [(88, 58), (95, 56), (92, 64)], [(34, 30), (39, 26), (40, 33)]]
    if detail: shards.append([(66, 58), (71, 56), (70, 62)])
    for sh in shards:
        g.append(f'<polygon points="{P(sh)}" fill="{ROCK[1]}" stroke="{INK}" stroke-width="{sw * .55:.1f}" stroke-linejoin="round"/>')
    # the emerald, tumbling out toward the viewer, with a glow behind it
    ex, ey, er = 70, 30, 16
    gx, gy = T(ex, ey)

    rot = math.radians(14)
    def R(px, py):
        dx, dy = px - ex, py - ey
        return (ex + dx * math.cos(rot) - dy * math.sin(rot), ey + dx * math.sin(rot) + dy * math.cos(rot))
    gem = [R(ex - er, ey - er * .3), R(ex - er * .52, ey - er * .95), R(ex + er * .52, ey - er * .95), R(ex + er, ey - er * .3), R(ex, ey + er * 1.05)]
    table = [R(ex - er * .52, ey - er * .3), R(ex - er * .26, ey - er * .64), R(ex + er * .26, ey - er * .64), R(ex + er * .52, ey - er * .3), R(ex, ey + er * .5)]
    g.append(f'<polygon points="{P(gem)}" fill="{EMERALD}" stroke="{INK}" stroke-width="{sw:.1f}" stroke-linejoin="round"/>')
    g.append(f'<polygon points="{P(table)}" fill="{EM_LIGHT}" opacity=".85"/>')
    g.append(f'<polygon points="{P([table[0], table[1], R(ex, ey - er * .3), table[4]])}" fill="#fff" opacity=".6"/>')
    if detail:
        for (sx0, sy0, r1) in [(90, 70, 6.5), (52, 6, 4.5)]:
            sx, sy = T(sx0, sy0)
            star = []
            for j in range(8):
                r = (r1 if j % 2 == 0 else r1 * .26) * k
                a = j * math.pi / 4 - math.pi / 2
                star.append((sx + r * math.cos(a), sy + r * math.sin(a)))
            g.append(f'<polygon points="{poly(star)}" fill="#fff"/>')
    # the tank, bottom left, barrel on the boulder
    cx, cy, Rt = 28, 74, 20
    ang = math.atan2(40 - cy, 62 - cx)
    ca, sa = math.cos(ang), math.sin(ang)
    bx = lambda d, w: T(cx + ca * d - sa * w, cy + sa * d + ca * w)
    Lb, Wb = Rt * 1.85, Rt * .82
    g.append(f'<polygon points="{poly([bx(0, -Wb / 2), bx(Lb, -Wb / 2), bx(Lb, Wb / 2), bx(0, Wb / 2)])}" fill="{BARREL}" stroke="{INK}" stroke-width="{sw:.1f}" stroke-linejoin="round"/>')
    # muzzle flash and the shot in flight
    if detail:
        fx, fy = cx + ca * (Lb + 4), cy + sa * (Lb + 4)
        flash = []
        for j in range(10):
            r = (9 if j % 2 == 0 else 4.5)
            a = ang + (j - 5) * math.pi / 5 * .55
            flash.append((fx + math.cos(a) * r * (1.3 if j == 5 else 1), fy + math.sin(a) * r * (1.3 if j == 5 else 1)))
        g.append(f'<polygon points="{P(flash)}" fill="#ffd76e" stroke="{INK}" stroke-width="{sw * .55:.1f}" stroke-linejoin="round"/>')
    tcx, tcy = T(cx, cy)
    g.append(f'<circle cx="{tcx:.1f}" cy="{tcy:.1f}" r="{Rt * k:.1f}" fill="{TANK}" stroke="{INK}" stroke-width="{sw:.1f}"/>')
    hx, hy = T(cx - 7, cy - 8)
    g.append(f'<circle cx="{hx:.1f}" cy="{hy:.1f}" r="{5.5 * k:.1f}" fill="#fff" opacity=".35"/>')
    return '\n'.join(g)

def wordmark(x, baseline, size):
    top, w1 = text_path(FONT, 'DIG', size, x, baseline, size * .02)
    gap = size * .26
    bot, w2 = text_path(FONT, 'WARS', size, x + w1 + gap, baseline, size * .02)
    return top, bot, w1 + gap + w2

def lockup():
    size = 88
    H = 132
    em = 132
    tx = em + 10
    base = 96
    dig, wars, tw = wordmark(tx, base, size)
    W = tx + tw + 14
    sw = size * .13
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H}" width="{W:.0f}" height="{H}" role="img" aria-label="Dig Wars">',
         '<title>Dig Wars</title>',
         '<defs>',
         '<linearGradient id="dwGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1b8"/><stop offset=".45" stop-color="#ffcf4d"/><stop offset="1" stop-color="#e8862e"/></linearGradient>',
         '<linearGradient id="dwStone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#e9e3d6"/><stop offset="1" stop-color="#a9a196"/></linearGradient>',
         '</defs>',
         emblem(0, 0, em)]
    for path, fill in ((dig, 'url(#dwGold)'), (wars, 'url(#dwStone)')):
        s.append(f'<path d="{path}" transform="translate(3 6)" fill="#000" opacity=".4" stroke="#000" stroke-width="{sw:.1f}" stroke-linejoin="round"/>')
        # warm rim outside the ink, so the letters keep an edge on dark pages
        s.append(f'<path d="{path}" fill="none" stroke="#6b4c2a" stroke-width="{sw + 7:.1f}" stroke-linejoin="round"/>')
        s.append(f'<path d="{path}" fill="{fill}" stroke="{INK}" stroke-width="{sw:.1f}" stroke-linejoin="round" paint-order="stroke"/>')
    # a shine band across the top of the letters
    s.append('</svg>')
    return '\n'.join(s)

def icon():
    s = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">',
         '<title>Dig Wars</title>',
         '<defs><radialGradient id="dwBg" cx=".45" cy=".4" r=".75"><stop offset="0" stop-color="#6b4c2a"/><stop offset=".6" stop-color="#3a2814"/><stop offset="1" stop-color="#1e140a"/></radialGradient>'
         '</defs>',
         '<rect x="2" y="2" width="96" height="96" rx="22" fill="url(#dwBg)" stroke="#8a6a3e" stroke-width="2.5"/>',
         emblem(2, 4, 96, detail=False),
         '</svg>']
    return '\n'.join(s)

open(OUT + '/logo.svg', 'w').write(lockup())
open(OUT + '/icon.svg', 'w').write(icon())
print('ok')

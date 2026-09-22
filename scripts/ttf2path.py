# Minimal TrueType reader: text -> SVG path data (quadratic outlines), with advance widths and kerning-free spacing.
import struct, sys
def load(path):
    d = open(path, 'rb').read()
    n = struct.unpack('>H', d[4:6])[0]
    t = {}
    for i in range(n):
        tag, _, off, ln = struct.unpack('>4sIII', d[12 + 16 * i: 28 + 16 * i])
        t[tag.decode()] = (off, ln)
    return d, t
def font(path):
    d, t = load(path)
    ho = t['head'][0]; upem = struct.unpack('>H', d[ho + 18:ho + 20])[0]; locfmt = struct.unpack('>h', d[ho + 50:ho + 52])[0]
    hh = t['hhea'][0]; nhm = struct.unpack('>H', d[hh + 34:hh + 36])[0]
    mo = t['maxp'][0]; ng = struct.unpack('>H', d[mo + 4:mo + 6])[0]
    lo = t['loca'][0]
    loca = [struct.unpack('>H', d[lo + 2 * i:lo + 2 * i + 2])[0] * 2 for i in range(ng + 1)] if locfmt == 0 else [struct.unpack('>I', d[lo + 4 * i:lo + 4 * i + 4])[0] for i in range(ng + 1)]
    hm = t['hmtx'][0]
    adv = [struct.unpack('>H', d[hm + 4 * min(i, nhm - 1):hm + 4 * min(i, nhm - 1) + 2])[0] for i in range(ng)]
    # cmap format 4
    co = t['cmap'][0]; nt = struct.unpack('>H', d[co + 2:co + 4])[0]; sub = None
    for i in range(nt):
        pid, eid, off = struct.unpack('>HHI', d[co + 4 + 8 * i:co + 12 + 8 * i])
        if struct.unpack('>H', d[co + off:co + off + 2])[0] == 4: sub = co + off; break
    segx2 = struct.unpack('>H', d[sub + 6:sub + 8])[0]; seg = segx2 // 2
    ends = [struct.unpack('>H', d[sub + 14 + 2 * i:sub + 16 + 2 * i])[0] for i in range(seg)]
    so = sub + 16 + segx2
    starts = [struct.unpack('>H', d[so + 2 * i:so + 2 * i + 2])[0] for i in range(seg)]
    do = so + segx2; deltas = [struct.unpack('>h', d[do + 2 * i:do + 2 * i + 2])[0] for i in range(seg)]
    ro = do + segx2; ranges = [struct.unpack('>H', d[ro + 2 * i:ro + 2 * i + 2])[0] for i in range(seg)]
    def gid(ch):
        c = ord(ch)
        for i in range(seg):
            if starts[i] <= c <= ends[i]:
                if ranges[i] == 0: return (c + deltas[i]) & 0xffff
                a = ro + 2 * i + ranges[i] + 2 * (c - starts[i]); g = struct.unpack('>H', d[a:a + 2])[0]
                return (g + deltas[i]) & 0xffff if g else 0
        return 0
    go = t['glyf'][0]
    def contours(g):
        s, e = loca[g], loca[g + 1]
        if s == e: return []
        p = go + s
        nc = struct.unpack('>h', d[p:p + 2])[0]
        if nc < 0: raise Exception('composite glyph')
        endpts = [struct.unpack('>H', d[p + 10 + 2 * i:p + 12 + 2 * i])[0] for i in range(nc)]
        npts = endpts[-1] + 1
        il = struct.unpack('>H', d[p + 10 + 2 * nc:p + 12 + 2 * nc])[0]
        q = p + 12 + 2 * nc + il
        flags = []
        while len(flags) < npts:
            f = d[q]; q += 1; flags.append(f)
            if f & 8:
                r = d[q]; q += 1; flags += [f] * r
        xs = []; x = 0
        for f in flags:
            if f & 2: v = d[q]; q += 1; x += v if f & 16 else -v
            elif not f & 16: x += struct.unpack('>h', d[q:q + 2])[0]; q += 2
            xs.append(x)
        ys = []; y = 0
        for f in flags:
            if f & 4: v = d[q]; q += 1; y += v if f & 32 else -v
            elif not f & 32: y += struct.unpack('>h', d[q:q + 2])[0]; q += 2
            ys.append(y)
        out = []; st = 0
        for en in endpts:
            out.append([(xs[i], ys[i], flags[i] & 1) for i in range(st, en + 1)]); st = en + 1
        return out
    return upem, gid, adv, contours
def glyph_path(cs, ox, oy, s):
    parts = []
    P = lambda x, y: f'{ox + x * s:.1f} {oy - y * s:.1f}'
    for c in cs:
        # expand implied on-curve points
        pts = []
        n = len(c)
        for i in range(n):
            a, b = c[i], c[(i + 1) % n]
            pts.append(a)
            if not a[2] and not b[2]: pts.append(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 1))
        k = next(i for i, p in enumerate(pts) if p[2]); pts = pts[k:] + pts[:k]
        seg = 'M' + P(pts[0][0], pts[0][1]); i = 1; m = len(pts)
        while i <= m:
            p = pts[i % m]
            if p[2]: seg += 'L' + P(p[0], p[1]); i += 1
            else:
                e = pts[(i + 1) % m]; seg += 'Q' + P(p[0], p[1]) + ' ' + P(e[0], e[1]); i += 2
        parts.append(seg + 'Z')
    return ''.join(parts)
def text_path(fontfile, text, size, x0, baseline, tracking=0):
    upem, gid, adv, contours = font(fontfile)
    s = size / upem; x = x0; out = []
    for ch in text:
        g = gid(ch)
        out.append(glyph_path(contours(g), x, baseline, s))
        x += adv[g] * s + tracking
    return ''.join(out), x - tracking - x0
if __name__ == '__main__':
    p, w = text_path(sys.argv[1], sys.argv[2], float(sys.argv[3]), 0, 0, float(sys.argv[4]) if len(sys.argv) > 4 else 0)
    print(w); print(p[:200])

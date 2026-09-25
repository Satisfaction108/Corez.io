import math
C=512; R=268; INK="#101418"
def pt(r,deg): return (C+r*math.cos(math.radians(deg)), C+r*math.sin(math.radians(deg)))
def P(*ps): return ' '.join(f'{x:.1f},{y:.1f}' for x,y in ps)
out=[]
# barrels: square inner end (hidden under the body), rounded outer corners
W=round(R*0.9); L=round(R*1.78); rr=34
x0=C-W/2; x1=C+W/2; yT=C-L; yB=C
d=f'M{x0},{yB} L{x0},{yT+rr} Q{x0},{yT} {x0+rr},{yT} L{x1-rr},{yT} Q{x1},{yT} {x1},{yT+rr} L{x1},{yB} Z'
for i in range(8):
    out.append(f'<path d="{d}" fill="#5a5670" stroke="#1d1b24" stroke-width="24" stroke-linejoin="round" transform="rotate({i*45} {C} {C})"/>')
# emerald body in the style of the reference: flat-top centre hexagon, a ring of
# facets around it, two small rim facets at the sides, darker band at the bottom
h=150
V=[pt(h,a) for a in (0,60,120,180,240,300)]      # 0=right, 60=lower-right ... 240=upper-left, 300=upper-right
rim=lambda a: pt(R+60,a)
rimA={'t1':235,'t2':305,'r1':-18,'r2':18,'b1':65,'b2':115,'l1':162,'l2':198}
Rr=lambda k: rim(rimA[k])
facets=[
  (P(V[4],V[5],Rr('t2'),Rr('t1')), '#a4f5b4'),                         # top
  (P(V[5],V[0],Rr('r1'),rim(330),Rr('t2')), '#2ecc6e'),                 # upper-right
  (P(V[0],Rr('r2'),Rr('r1')), '#1f9d57'),                               # right sliver
  (P(V[0],V[1],Rr('b1'),rim(40),Rr('r2')), '#52e67a'),                  # lower-right
  (P(V[1],V[2],Rr('b2'),rim(90),Rr('b1')), '#2ecc6e'),                  # bottom
  (P(V[2],V[3],Rr('l1'),rim(140),Rr('b2')), '#149955'),                 # lower-left
  (P(V[3],Rr('l2'),rim(180),Rr('l1')), '#52e67a'),                      # left sliver
  (P(V[3],V[4],Rr('t1'),rim(216),Rr('l2')), '#3ad06a'),                 # upper-left
]
body=[f'<clipPath id="c"><circle cx="{C}" cy="{C}" r="{R}"/></clipPath>',
      f'<circle cx="{C}" cy="{C}" r="{R}" fill="#2ecc6e"/>','<g clip-path="url(#c)">']
for pts,col in facets: body.append(f'<polygon points="{pts}" fill="{col}"/>')
body.append(f'<rect x="{C-160}" y="{C+R-44}" width="320" height="60" fill="#117a45"/>')   # dark band at the bottom
body.append(f'<polygon points="{P(*V)}" fill="#a4f5b4"/>')
lines=[(V[4],Rr('t1')),(V[5],Rr('t2')),(V[0],Rr('r1')),(V[0],Rr('r2')),(V[1],Rr('b1')),(V[2],Rr('b2')),(V[3],Rr('l1')),(V[3],Rr('l2'))]
for a,b in lines: body.append(f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}" stroke="{INK}" stroke-width="20" stroke-linecap="round"/>')
body.append(f'<polygon points="{P(*V)}" fill="none" stroke="{INK}" stroke-width="20" stroke-linejoin="round"/>')
# the dark band only belongs to the bottom facet: redraw the neighbours' edges over it
body.append(f'<line x1="{V[1][0]:.1f}" y1="{V[1][1]:.1f}" x2="{Rr("b1")[0]:.1f}" y2="{Rr("b1")[1]:.1f}" stroke="{INK}" stroke-width="20" stroke-linecap="round"/>')
body.append(f'<line x1="{V[2][0]:.1f}" y1="{V[2][1]:.1f}" x2="{Rr("b2")[0]:.1f}" y2="{Rr("b2")[1]:.1f}" stroke="{INK}" stroke-width="20" stroke-linecap="round"/>')
# glint: a slanted bar centred in the upper-left facet
g=[(312,440),(338,450),(398,366),(384,346),(372,346)]
body.append(f'<polygon points="{P(*g)}" fill="#ffffff"/>')
body.append('</g>')
body.append(f'<circle cx="{C}" cy="{C}" r="{R}" fill="none" stroke="{INK}" stroke-width="32"/>')
svg=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">{"".join(out)}{"".join(body)}</svg>'
open('corez-logo.svg','w').write(svg)
open('page.html','w').write(f'<html><body style="margin:0;background:transparent">{svg}</body></html>')

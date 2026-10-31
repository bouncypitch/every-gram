"""Generic mug study: 82 mm OD, 95 mm tall, 350 ml coffee, with C-handle. Dimensions are typical, not a specific product."""
import numpy as np,trimesh,lighten,fe,json
from scipy import ndimage as ni
OD,H=.082,.095; GR=9.81; LIQ=.35
def mug(wall,base,hw=.012,ht=.008):
    outer=trimesh.creation.cylinder(radius=OD/2,height=H,sections=96)
    inner=trimesh.creation.cylinder(radius=OD/2-wall,height=H,sections=96); inner.apply_translation([0,0,base])
    body=trimesh.boolean.difference([outer,inner],engine='manifold')
    # handle: elliptical ring slab, clipped to outside of body
    r=.028; c=trimesh.creation.annulus(r_min=r-ht,r_max=r,height=hw,sections=64)
    c.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2,[1,0,0])); c.apply_translation([OD/2+.012,0,0])
    cut=trimesh.creation.cylinder(radius=OD/2-wall/2,height=H+.01,sections=96)
    h=trimesh.boolean.difference([c,cut],engine='manifold')
    return trimesh.boolean.union([body,h],engine='manifold')
def run(name,wall,base,hw,ht,rho,E,allow):
    m=mug(wall,base,hw,ht); f=f'out/mug_{name}.stl'; m.export(f); g=.0008
    s,G=lighten.voxelize(f,g); X,Y,Z=G
    grip=(X>OD/2+.018)&s; bot=(Z<-H/2+base)&(np.hypot(X,Y)<OD/2)&s
    w=(m.volume*rho+LIQ)*GR*3   # full mug, 3 g lift or jerk
    r=fe.solve(s,g,E,.22,grip,[(bot,[0,0,-w])],tol=1e-5)
    near=ni.binary_dilation(grip|bot,iterations=2)
    p=lighten.peak(r['vm'],s,near); mass=m.volume*rho*1e3
    print(name,f'wall {wall*1e3:.1f} mm mass {mass:.0f} g load {w:.1f} N peak {p/1e6:.1f}/{allow/1e6:.0f} MPa',flush=True)
    return dict(name=name,wall_mm=wall*1e3,mass_g=mass,peak_mpa=p/1e6,allow_mpa=allow/1e6,simulated=True)
R=[run('ceramic_5',.005,.006,.014,.010,2400,70e9,20e6),run('ceramic_3p5',.0035,.005,.014,.010,2400,70e9,20e6),run('ceramic_2p5',.0025,.004,.014,.010,2400,70e9,20e6),run('porcelain_2p5',.0025,.004,.014,.010,2400,80e9,30e6)]
# Calculated (not simulated) options: mass = shell area x wall x density
A=np.pi*OD*H+2*np.pi*(OD/2)**2
Q=[('Single-wall titanium 0.5 mm',A*.0005*4430*1e3+25,'high heat loss, hot to hold'),('Double-wall vacuum stainless 0.4 mm',2*A*.0004*8000*1e3+30,'best heat retention'),('Double-wall vacuum titanium 0.4 mm',2*A*.0004*4430*1e3+25,'best heat retention, most expensive')]
for n,m,c in Q: print(f'{n}: about {m:.0f} g ({c})')
def tip(m_g,liq_g,fill): # angle to tip, empty handle ignored, centre of mass height
    b=.03; h=(m_g*.05+liq_g*.0475*fill)/(m_g+liq_g)*1; return np.degrees(np.arctan(b/h))
for n,m in [('Ceramic 300 g',300),('Light 120 g',120)]: print(n,'tip angle empty deg',round(tip(m,0,1),1),'full',round(tip(m,350,1),1))
json.dump(R,open('out/mug.json','w'),indent=1)

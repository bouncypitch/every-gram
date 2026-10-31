"""Aluminum skins over aluminum foam core. Gibson-Ashby: E*=E phi^2, strength*=0.3 strength phi^1.5."""
import json,numpy as np,jobs,lighten,fe
from scipy import ndimage as ni
job=jobs.JOBS['foot']; h=job['h']; E0=2.5e9; nu=.33; Ea=69e9; rhoa=2700; ya=276e6
s,g=lighten.voxelize(job['mesh'],h)
fixed=np.zeros_like(s)
for r in job['supports']: fixed|=lighten.region(g,r)&s
cases=[[(lighten.region(g,l)&s,l['F']) for l in c] for c in job['cases']]
masks=[np.any([m for m,_ in c],axis=0) for c in cases]; anym=np.any(masks,axis=0)
near=ni.binary_dilation(fixed|anym,iterations=2); boss=ni.binary_dilation(fixed|anym,iterations=job['boss'])
base=[fe.solve(s,h,E0,.35,fixed,c,tol=1e-5) for c in cases]; b=[lighten.tip(r,m,s) for r,m in zip(base,masks)]
depth=ni.distance_transform_edt(np.pad(s,1))[1:-1,1:-1,1:-1]; out=[]
for sk in (.0015,.003):
  for phi in (.08,.12,.18):
    skin=(depth<=sk/h+.5)|boss; core=s&~skin; sc=np.where(core,phi**2,1.)
    rs=[fe.solve(s,h,Ea,nu,fixed,c,tol=1e-5,scale=sc) for c in cases]
    ps=max(np.percentile(r['vm'][skin&s&~near],99.5) for r in rs); pc=max(np.percentile(r['vm'][core&~near],99.5) for r in rs)
    dr=max(lighten.tip(r,m,s)/y for r,m,y in zip(rs,masks,b))
    mass=(int((s&skin).sum())+phi*int(core.sum()))*h**3*rhoa*1e3
    ac=.3*ya*phi**1.5/2; ok=ps<=138e6 and pc<=ac and dr<=1.10
    o=dict(skin_mm=sk*1e3,phi=phi,foam_kg_m3=phi*rhoa,mass_g=mass,ratio=mass/454.3,skin_mpa=ps/1e6,core_mpa=pc/1e6,core_limit=ac/1e6,defl=dr,ok=bool(ok)); out.append(o); print(o,flush=True)
json.dump(out,open('out/foam_foot.json','w'),indent=1)

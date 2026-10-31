"""Borrowed structures: skin plus a through-thickness rib core, sized by bisection on rib width.
isogrid = triangular ribs from launch-vehicle skins; honeycomb = hexagonal cells from aircraft sandwich panels."""
import sys,json,pickle,numpy as np,jobs,lighten,fe
from scipy import ndimage as ni
k,pat=sys.argv[1],sys.argv[2]; job=dict(jobs.JOBS[k]); job['h']=.001; h=job['h']; nu=job['nu']; E0=2.5e9
E=7e9; rho=1150; allow=30e6; rho0=1346
AXIS=dict(yoke=1,foot=2,arm=0,hip=2)[k]; L=dict(yoke=.016,foot=.024,arm=.018,hip=.018)[k]
s,g=lighten.voxelize(job['mesh'],h)
fixed=np.zeros_like(s)
for r in job['supports']: fixed|=lighten.region(g,r)&s
cases=[[(lighten.region(g,l)&s,l['F']) for l in c] for c in job['cases']]
masks=[np.any([m for m,_ in c],axis=0) for c in cases]; any_m=np.any(masks,axis=0)
near=ni.binary_dilation(fixed|any_m,iterations=2)
keep=ni.binary_dilation(fixed|any_m,iterations=4)
from review import holes_rim
keep|=holes_rim(s,h)[1]
depth=ni.distance_transform_edt(np.pad(s,1))[1:-1,1:-1,1:-1]
base=[fe.solve(s,h,E0,nu,fixed,c,tol=1e-5) for c in cases]; b_d=[lighten.tip(b,m,s) for b,m in zip(base,masks)]
u,v=[g[i] for i in range(3) if i!=AXIS]
if pat=='hollow':
    D=np.full(u.shape,1e9)
elif pat=='isogrid':
    dirs=[np.array([np.cos(a),np.sin(a)]) for a in (0,np.pi/3,2*np.pi/3)]
    D=np.min([np.abs(((u*n[0]+v*n[1])/L+.5)%1-.5)*L for n in dirs],axis=0)
else:
    # distance to hexagon walls = (R - max projection on 3 axes) on a hex tiling
    a=L; q=np.stack([u,v],-1)
    b1=np.array([a,0]); b2=np.array([a/2,a*np.sqrt(3)/2])
    M=np.linalg.inv(np.stack([b1,b2],1)); f=q@M.T
    i=np.round(f[...,0]); j=np.round(f[...,1])
    ds=[]
    for di in (-1,0,1):
        for dj in (-1,0,1):
            ds.append(np.linalg.norm(q-((i+di)[...,None]*b1+(j+dj)[...,None]*b2),axis=-1))
    ds=np.sort(np.stack(ds),axis=0); D=(ds[1]-ds[0])/2
build=lambda w,sk: lighten.largest(s&((depth<=sk/h+.5)|keep|(D<w/2)))
out=[]; bestd=None
plans=[(.0015,0),(.002,0),(.0025,0),(.003,0),(.004,0),(.005,0),(.006,0)] if pat=='hollow' else None
for sk in (plans and [p[0] for p in plans]) or (.003,.002):
    lo,hi=.002,.010
    for i in range(1 if pat=='hollow' else 5):
        w=(lo+hi)/2; d=build(0 if pat=='hollow' else w,sk)
        rs=[fe.solve(d,h,E0,nu,fixed&d,[(m&d,F) for m,F in ca],tol=1e-5) for ca in cases]
        p=max(lighten.peak(r['vm'],d,near) for r in rs); dr=max(lighten.tip(r,m&d,d)/y for r,m,y in zip(rs,masks,b_d))*E0/E
        ok=p<=allow and dr<=job['max_deflection_ratio']; fr=float(d.sum()/s.sum())
        print(k,pat,f'skin {sk*1e3:.1f} rib {w*1e3:.2f} fill {fr:.3f} mass {fr*rho/rho0:.3f} peak {p/1e6:.1f} stiff {dr:.3f}','PASS' if ok else 'fail',flush=True)
        if ok:
            hi=w
            if bestd is None or fr<bestd['fill']: bestd=dict(solid=d.copy(),vm=np.max([r['vm'] for r in rs],axis=0),peak=p,dr=dr,fill=fr,mass_ratio=fr*rho/rho0,skin=sk,rib=w)
        else: lo=w
pickle.dump(dict(job=k,pattern=pat,best=bestd,material='Nylon 12 + CF',h=h),open(f'out/v2_pat_{k}_{pat}.pkl','wb'))
print(k,pat,'done',None if bestd is None else (bestd['fill'],bestd['mass_ratio']),flush=True)

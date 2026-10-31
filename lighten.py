"""Generic job: mesh + material + supports + loads -> verified lighter voxel part."""
import json, sys, time, numpy as np, trimesh
from scipy import ndimage as ni
import fe

def voxelize(path, h):
    """Scanline parity fill along z; each closed shell toggles occupancy."""
    t = trimesh.load(path, force='mesh')
    parts = t.split(only_watertight=False)
    if not all(p.is_watertight for p in parts):
        raise ValueError('mesh is not a closed solid; need a watertight model')
    lo = t.bounds[0]-h; n = np.ceil((t.bounds[1]-t.bounds[0])/h).astype(int)+2
    ax = [lo[i]+(np.arange(n[i])+.5)*h for i in range(3)]
    s = np.zeros(n,bool)
    for p in parts:
        cross = np.zeros(n,np.int32)
        for a,b,c in p.triangles:
            x0,x1 = min(a[0],b[0],c[0]),max(a[0],b[0],c[0]); y0,y1 = min(a[1],b[1],c[1]),max(a[1],b[1],c[1])
            i0,i1 = np.searchsorted(ax[0],[x0,x1]); j0,j1 = np.searchsorted(ax[1],[y0,y1])
            if i0>=i1 or j0>=j1: continue
            d = (b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1])
            if abs(d)<1e-18: continue
            px,py = np.meshgrid(ax[0][i0:i1],ax[1][j0:j1],indexing='ij')
            u = ((px-a[0])*(c[1]-a[1])-(c[0]-a[0])*(py-a[1]))/d
            v = ((b[0]-a[0])*(py-a[1])-(px-a[0])*(b[1]-a[1]))/d
            m = (u>=0)&(v>=0)&(u+v<=1)
            z = a[2]+u[m]*(b[2]-a[2])+v[m]*(c[2]-a[2])
            k = np.searchsorted(ax[2],z)
            I,J = np.nonzero(m); ok = k<n[2]
            np.add.at(cross,(I[ok]+i0,J[ok]+j0,k[ok]),1)
        s |= (np.cumsum(cross,axis=2)%2).astype(bool)
    X,Y,Z = np.meshgrid(*ax, indexing='ij')
    lab,k = ni.label(s)
    if k>1:
        c = np.bincount(lab.ravel()); c[0]=0; s = lab==c.argmax()
    return s,(X,Y,Z)

def cyl(g, r):
    """Elements within a cylinder: point p, axis d, radii r0..r1."""
    X,Y,Z = g; p=np.array(r['p']); d=np.array(r['d'],float); d/=np.linalg.norm(d)
    v = np.stack([X-p[0],Y-p[1],Z-p[2]],-1)
    rad = np.linalg.norm(np.cross(v,d),axis=-1)
    return (rad>=r.get('r0',0))&(rad<=r['r1'])

def region(g, r):
    m = cyl(g, r) if 'p' in r else np.ones(g[0].shape,bool)
    for i,k in enumerate('xyz'):
        if k+'min' in r: m &= g[i] >= r[k+'min']
        if k+'max' in r: m &= g[i] <= r[k+'max']
    return m

def largest(s):
    lab,k = ni.label(s)
    if k<2: return s
    c = np.bincount(lab.ravel()); c[0]=0
    return lab==c.argmax()

def tip(r, load_el, solid):
    n = np.unique(r['en'][load_el[solid]])
    return float(np.linalg.norm(r['u'][(n[:,None]*3+np.arange(3))].mean(0)))

def peak(vm, solid, exclude):
    """Robust peak: 99.5th percentile away from idealized load/support regions."""
    return float(np.percentile(vm[solid&~exclude],99.5))

def run(job, log=print):
    """job['cases'] is a list of load sets; a design must pass all of them."""
    h,E,nu,rho = job['h'],job['E'],job['nu'],job['rho']
    s,g = voxelize(job['mesh'],h)
    fixed = np.zeros_like(s)
    for r in job['supports']: fixed |= region(g,r)&s
    cases = [[(region(g,l)&s,l['F']) for l in c] for c in job['cases']]
    masks = [np.any([m for m,_ in c],axis=0) for c in cases]
    near = ni.binary_dilation(fixed|np.any(masks,axis=0),iterations=2)
    base = [fe.solve(s,h,E,nu,fixed,c) for c in cases]
    b_p = [peak(b['vm'],s,near) for b in base]; b_d = [tip(b,m,s) for b,m in zip(base,masks)]
    vm0 = np.max([b['vm'] for b in base],axis=0)
    log(f"baseline {s.sum()*h**3*rho*1e3:.1f} g peaks {[round(p/1e6,2) for p in b_p]} MPa defl {[round(d*1e6,1) for d in b_d]} um")
    if max(b_p)>job['allowable']: log('baseline over allowable')
    depth = ni.distance_transform_edt(np.pad(s,1))[1:-1,1:-1,1:-1]
    keep = (depth<=job['skin']/h+.5)|ni.binary_dilation(fixed|np.any(masks,axis=0),iterations=job['boss'])
    c = 2*np.pi/job['cell']; X,Y,Z = g
    G = np.sin(c*X)*np.cos(c*Y)+np.sin(c*Y)*np.cos(c*Z)+np.sin(c*Z)*np.cos(c*X)
    sf = ni.gaussian_filter(vm0,3); sm = sf/max(sf[s].max(),1)
    build = lambda t: largest(s&(keep|(np.abs(G)<t*(.45+1.1*np.sqrt(sm)))))
    lo,hi,best = .1,1.6,None
    for i in range(job.get('steps',6)):
        t = (lo+hi)/2; d = build(t)
        rs = [fe.solve(d,h,E,nu,fixed&d,[(m&d,F) for m,F in ca]) for ca in cases]
        ps = [peak(r['vm'],d,near) for r in rs]; ds = [tip(r,m&d,d) for r,m in zip(rs,masks)]
        ok = max(ps)<=job['allowable'] and all(x<=y*job['max_deflection_ratio'] for x,y in zip(ds,b_d)) and all(r['info']==0 for r in rs)
        log(f" t={t:.3f} ratio {d.sum()/s.sum():.3f} peaks {[round(p/1e6,2) for p in ps]} defl+ {[round(x/y,3) for x,y in zip(ds,b_d)]} {'PASS' if ok else 'fail'}")
        if ok: hi,best = t,dict(solid=d,vm=np.max([r['vm'] for r in rs],axis=0),peaks=ps,defl=ds)
        else: lo = t
    return dict(solid=s,grid=g,vm0=vm0,base_peaks=b_p,base_defl=b_d,best=best,job=job)

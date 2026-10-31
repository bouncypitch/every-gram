"""Evolutionary topology removal: drop the least-stressed material each step, re-solve, keep the lightest passing design."""
import sys,pickle,json,time,numpy as np,jobs,lighten,fe
from scipy import ndimage as ni
k=sys.argv[1]; job=jobs.JOBS[k]; h=job['h']; nu=job['nu']; E0=2.5e9
E=7e9; rho=1150; allow=30e6   # Nylon 12 + CF, typical datasheet values
ratio_E=E0/E; rho0=1346
s,g=lighten.voxelize(job['mesh'],h)
fixed=np.zeros_like(s)
for r in job['supports']: fixed|=lighten.region(g,r)&s
cases=[[(lighten.region(g,l)&s,l['F']) for l in c] for c in job['cases']]
masks=[np.any([m for m,_ in c],axis=0) for c in cases]; any_m=np.any(masks,axis=0)
near=ni.binary_dilation(fixed|any_m,iterations=2)
keep=ni.binary_dilation(fixed|any_m,iterations=job['boss'])&s
sol=lambda d:[fe.solve(d,h,E0,nu,fixed&d,[(m&d,F) for m,F in ca],tol=1e-5) for ca in cases]
rs=sol(s); b_d=[lighten.tip(r,m,s) for r,m in zip(rs,masks)]; V0=int(s.sum())
d=s.copy(); best=None; t0=time.time(); fails=0; step=.10
for it in range(30):
    vm=np.max([r['vm'] for r in rs],axis=0)
    # smooth sensitivity so removal makes features, not speckle
    w=ni.gaussian_filter(d.astype(float),2)+1e-9; sens=ni.gaussian_filter(vm,2)/w
    target=int(d.sum()*(1-step)); c=np.sort(sens[d&~keep])
    n=int(d.sum())-target
    if n>=len(c): break
    th=c[n]; nd=(d&(sens>th))|keep
    nd=ni.binary_opening(nd,iterations=1,structure=ni.generate_binary_structure(3,1))|keep
    nd=lighten.largest(nd)
    if not (nd&any_m).sum() or (nd&fixed).sum()<(s&fixed).sum()*.9: break
    try: nr=sol(nd)
    except Exception as e: print(k,'solve err',e,flush=True); break
    p=max(lighten.peak(r['vm'],nd,near) for r in nr); dr=max(lighten.tip(r,m&nd,nd)/y for r,m,y in zip(nr,masks,b_d))
    ok=p<=allow and dr*ratio_E<=job['max_deflection_ratio'] and all(r['info']==0 for r in nr)
    fr=nd.sum()/V0; mr=fr*rho/rho0
    print(k,f'it {it} fill {fr:.3f} mass {mr:.3f} peak {p/1e6:.1f} stiff {dr*ratio_E:.3f} {"PASS" if ok else "fail"} {time.time()-t0:.0f}s',flush=True)
    if ok:
        d,rs=nd,nr; best=dict(solid=nd.copy(),vm=np.max([r['vm'] for r in nr],axis=0),peak=p,dr=dr*ratio_E,fill=float(fr),mass_ratio=float(mr)); fails=0
    else:
        fails+=1; step/=2
        if fails>2: break
    pickle.dump(dict(job=k,solid0=s,best=best,material='Nylon 12 + CF',V0=V0,h=h),open(f'out/topo_{k}.pkl','wb'))
print(k,'done',None if best is None else (best['fill'],best['mass_ratio'],best['peak']/1e6,best['dr']),flush=True)

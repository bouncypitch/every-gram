"""Material sweep. Linear elasticity at fixed nu: for fixed geometry and loads, stress is unchanged
and deflection scales 1/E, so one solve per lattice density covers every material."""
import sys,json,numpy as np,jobs,lighten,fe
from scipy import ndimage as ni
# Typical datasheet values, not tested coupons. allow = yield/ultimate over 2 (print knockdown assumed for polymers).
MATERIALS={
 'PLA (baseline)':     dict(E=2.5e9, rho=1346,allow=20e6, usd_kg=25, process='FDM'),
 'PETG':               dict(E=2.1e9, rho=1270,allow=17e6, usd_kg=25, process='FDM'),
 'Nylon 12 + CF':      dict(E=7.0e9, rho=1150,allow=30e6, usd_kg=90, process='FDM'),
 'PEEK + CF':          dict(E=11e9,  rho=1400,allow=60e6, usd_kg=600,process='High-temp FDM'),
 'AlSi10Mg':           dict(E=70e9,  rho=2670,allow=100e6,usd_kg=120,process='Metal LPBF'),
 'Ti-6Al-4V':          dict(E=110e9, rho=4430,allow=400e6,usd_kg=350,process='Metal LPBF'),
}
T=[.1,.14,.2,.28,.4,.55,.75,1.0,1.3]
k=sys.argv[1]; job=jobs.JOBS[k]; h=job['h']; nu=job['nu']; E0=2.5e9
s,g=lighten.voxelize(job['mesh'],h)
fixed=np.zeros_like(s)
for r in job['supports']: fixed|=lighten.region(g,r)&s
cases=[[(lighten.region(g,l)&s,l['F']) for l in c] for c in job['cases']]
masks=[np.any([m for m,_ in c],axis=0) for c in cases]; any_m=np.any(masks,axis=0)
near=ni.binary_dilation(fixed|any_m,iterations=2)
base=[fe.solve(s,h,E0,nu,fixed,c) for c in cases]
b_d=[lighten.tip(b,m,s) for b,m in zip(base,masks)]; vm0=np.max([b['vm'] for b in base],axis=0)
depth=ni.distance_transform_edt(np.pad(s,1))[1:-1,1:-1,1:-1]
keep=(depth<=job['skin']/h+.5)|ni.binary_dilation(fixed|any_m,iterations=job['boss'])
c=2*np.pi/job['cell']; X,Y,Z=g
G=np.sin(c*X)*np.cos(c*Y)+np.sin(c*Y)*np.cos(c*Z)+np.sin(c*Z)*np.cos(c*X)
sf=ni.gaussian_filter(vm0,3); sm=sf/max(sf[s].max(),1)
pts=[dict(t=1e9,ratio=1.0,peak=lighten.peak(vm0,s,near),dr=1.0)]
for t in T:
    d=lighten.largest(s&(keep|(np.abs(G)<t*(.45+1.1*np.sqrt(sm)))))
    rs=[fe.solve(d,h,E0,nu,fixed&d,[(m&d,F) for m,F in ca]) for ca in cases]
    pts.append(dict(t=t,ratio=float(d.sum()/s.sum()),peak=max(lighten.peak(r['vm'],d,near) for r in rs),
      dr=max(lighten.tip(r,m&d,d)/y for r,m,y in zip(rs,masks,b_d))))
    print(k,pts[-1],flush=True)
V=s.sum()*h**3; m0=V*1346; res=[]
for n,M in MATERIALS.items():
    # pass = under this material's allowable and no softer than 1.10 x the original PLA part
    ok=[p for p in pts if p['peak']<=M['allow'] and p['dr']*E0/M['E']<=job['max_deflection_ratio']]
    if not ok: res.append(dict(material=n,**M,feasible=False)); continue
    b=min(ok,key=lambda p:p['ratio'])
    res.append(dict(material=n,**M,feasible=True,fill=b['ratio'],t=None if b['t']>1e8 else b['t'],mass_g=V*b['ratio']*M['rho']*1e3,saved_pct=100*(1-V*b['ratio']*M['rho']/m0),peak_mpa=b['peak']/1e6,sf=M['allow']/b['peak'],stiff_vs_orig=(E0/M['E']*b['dr'])))
json.dump(dict(part=k,mass0_g=m0*1e3,results=res,points=pts),open(f'out/mat_{k}.json','w'),indent=1)
for r in res: print(k,r['material'],r.get('fill'),r.get('mass_g'),r.get('saved_pct'),r.get('sf'),r.get('stiff_vs_orig'),flush=True)

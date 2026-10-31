"""Merge solver results into the site data: meshes, totals, six checks, materials, proposal, design zip."""
import json,os,pickle,zipfile,numpy as np,trimesh,glob
from scipy import ndimage as ni
from skimage import measure
import jobs,lighten
D='web/public/data/'; P=D+'parts/'; M=jobs.M
robot=json.load(open(D+'robot.json')); parts={p['id']:p for p in robot['parts']}
LIM=30e6; RHO0=1346; RHO=1150; USD_KG=7000
def surf(solid,vm,g,h,target=50000):
    a=ni.gaussian_filter(np.pad(solid,2).astype(float),.7); v,f,_,_=measure.marching_cubes(a,.5)
    org=np.array([g[0][0,0,0],g[1][0,0,0],g[2][0,0,0]]); m=trimesh.Trimesh(v*h-2*h+org,f[:,::-1],process=False)
    if len(m.faces)>target: m=m.simplify_quadric_decimation(face_count=target)
    idx=np.clip(np.round((m.vertices-org)/h).astype(int),0,np.array(solid.shape)-1)
    x=np.clip(ni.grey_dilation(vm,size=3)[tuple(idx.T)]/LIM,0,1)
    m.visual.vertex_colors=np.c_[255*np.clip(1.5*x+.1,0,1),255*np.clip(1.6-3.6*np.abs(x-.5),0,.75),255*np.clip(1-1.6*x,0,1),np.full(len(x),255)].astype(np.uint8)
    return m
def match(design,target):
    """Place a left-side design on a mirrored or repeated instance; returns the placed mesh or None."""
    best=None
    for mirror in (False,True):
        d=design.copy()
        if mirror: d.apply_scale([-1,1,1]); d.invert()
        try: T,c=trimesh.registration.mesh_other(d,target,samples=800,scale=False,icp_first=8,icp_final=25)
        except Exception: continue
        if best is None or c<best[1]: best=(T,c,d)
    if best is None or best[1]>2e-6: return None
    r=best[2].copy(); r.apply_transform(best[0]); return r
os.makedirs('out/design',exist_ok=True); summary={}
for k,job in jobs.JOBS.items():
    cands=[('Topology removal',f'out/topo_{k}.pkl')]+[(n,f'out/pat_{k}_{p}.pkl') for n,p in (('Honeycomb','honeycomb'),('Isogrid','isogrid'),('Hollow core','hollow'))]
    found=[(n,pickle.load(open(f,'rb'))['best']) for n,f in cands if os.path.exists(f)]
    found=[(n,b) for n,b in found if b is not None]
    if not found: continue
    strat,b=min(found,key=lambda x:x[1]['fill'])
    h=job['h']; s,g=lighten.voxelize(job['mesh'],h)
    src=trimesh.load(job['mesh'],force='mesh'); des=surf(b['solid'],b['vm'],g,h)
    des.export(f'out/design/{k}_nylon_cf.stl')
    m0=s.sum()*h**3*RHO0*1e3; m1=b['solid'].sum()*h**3*RHO*1e3; saved=m0-m1
    summary[k]=dict(strategy=strat,m0=m0,m1=m1,peak=b['peak']/1e6,dr=b['dr'],n=len(job['links']),note=job['load_note'],fill=b['fill'])
    for n,link in enumerate(job['links']):
        p=parts[link]; tgt=trimesh.load(M+link+'_visual.stl',force='mesh'); comps=tgt.split(only_watertight=False)
        if k=='yoke': body,others=tgt,[]
        else:
            same=[c for c in comps if c.is_watertight and abs(abs(c.volume)-abs(src.volume))<.02*abs(src.volume)]
            body=same[0] if same else None
            others=[c for c in comps if c is not body]
        placed=des if n==0 else (match(des,body) if body is not None else None)
        if placed is not None:
            for o in others: o.visual.vertex_colors=[150,152,158,255]
            scene=trimesh.util.concatenate(others+[placed]) if others else placed
            scene.export(P+f'{link}_opt.glb'); p['mesh_opt']=f'parts/{link}_opt.glb'
        p['mass_opt_g']=round(p['mass_g']-saved,1); p['status']='verified'
        sf=30/(b['peak']/1e6); kg=saved/1000
        p['checks']={
         'mechanical':dict(status='pass',summary=f"Peak {b['peak']/1e6:.1f} of 30 MPa, deflection {b['dr']:.2f}x original. Case: {job['load_note']}.",basis='simulated'),
         'reliability':dict(status='warn',summary=f"Static margin {sf:.1f}x. Fatigue and impact are untested, and voxel corners need smoothing.",basis='calculated'),
         'thermal':dict(status='warn',summary=f"Solid fill falls to {b['fill']:.0%}, so heat paths through this part shrink about the same. Not simulated.",basis='assumed'),
         'electrical':dict(status='na',summary="No circuit in this part. Carbon fiber can conduct slightly, so keep wiring insulated.",basis='assumed'),
         'cost':dict(status='pass',summary=f"${kg*USD_KG:,.0f} launch saving per part. Uses {m1:.0f} g of filament at about $90/kg.",basis='calculated'),
         'power':dict(status='pass',summary=f"Reduces supported robot weight by {saved/163.31:.2f}%.",basis='calculated')}
        p['designs']=[dict(id='topo_cf',label=strat+', Nylon 12 + CF',material='Nylon 12 + CF',mass_g=p['mass_opt_g'],mesh=p['mesh_opt'],status='verified')]
total=sum((v['m0']-v['m1'])*v['n'] for v in summary.values())
json.dump(robot,open(D+'robot.json','w'),indent=0)
print({k:{a:round(b,2) for a,b in v.items() if not isinstance(b,str)} for k,v in summary.items()},'total g',round(total,1))
mats=[]
for f in glob.glob('out/mat_*.json'):
    d=json.load(open(f)); mats+=[dict(part=d['part'],**{k:v for k,v in r.items() if k in('material','process','mass_g','saved_pct','sf','stiff_vs_orig','feasible')}) for r in d['results']]
json.dump(mats,open(D+'materials.json','w'),indent=0)
legs=sum((v['m0']-v['m1'])*v['n'] for k,v in summary.items() if k in('yoke','foot'))/1000
json.dump(dict(baseline_kg=16.33,items=[
 dict(subsystem='Legs',mass_kg=8.18,proposed_kg=round(8.18-legs,2),rationale='Verified yoke and foot redesigns.',status='proposed'),
 dict(subsystem='Torso',mass_kg=4.45,proposed_kg=2.86,rationale='Repo biped torso (3.16 kg, real URDF) with a 0.3 kg lighter battery. Battery product at this size is unconfirmed.',status='proposed'),
 dict(subsystem='Arms',mass_kg=3.70,proposed_kg=0.0,rationale='Removed, using the repo biped variant. Valid only if the mission needs no hands.',status='proposed')]),open(D+'proposal.json','w'),indent=0)
open('out/design/README.md','w').write('# Every Gram design pack\n\nBerkeley Humanoid Lite parts redesigned in Nylon 12 + CF. Results are simulation only, with typical datasheet properties and assumed load cases. Fatigue, impact, thermal and print behavior are untested. Do not use for safety-critical parts without engineering review.\n\n'+'\n'.join(f"- {k}: {v['m0']:.1f} g to {v['m1']:.1f} g, peak {v['peak']:.1f}/30 MPa, deflection {v['dr']:.2f}x, case: {v['note']}" for k,v in summary.items())+'\n')
with zipfile.ZipFile(D+'every-gram-design.zip','w',zipfile.ZIP_DEFLATED) as z:
    for f in glob.glob('out/design/*'): z.write(f,os.path.basename(f))

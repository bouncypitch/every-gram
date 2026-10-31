import trimesh,glob,os,json,numpy as np
M='assets/data/robots/berkeley_humanoid/berkeley_humanoid_lite/meshes/'
rows=[];os.makedirs('out/solids',exist_ok=True)
for f in sorted(glob.glob(M+'*_visual.stl')):
    n=os.path.basename(f)[:-11]
    if 'right' in n: continue
    t=trimesh.load(f,force='mesh'); cs=t.split(only_watertight=False)
    wt=[c for c in cs if c.is_watertight and abs(c.volume)>3e-6]
    tot=sum(abs(c.volume) for c in wt)*1e6
    print(n,'comps',len(cs),'solids',[ (round(abs(c.volume)*1e6,1),(c.extents*1e3).round(0).tolist()) for c in sorted(wt,key=lambda c:-abs(c.volume))[:6]],'open faces',sum(len(c.faces) for c in cs if not c.is_watertight),'total cm3',round(tot,1))

import trimesh,numpy as np,os
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
import lighten
M='assets/data/robots/berkeley_humanoid/berkeley_humanoid_lite/meshes/'
want=[('foot','leg_left_ankle_roll',333.7),('arm','arm_left_shoulder_roll',98.3),('hip','leg_left_hip_roll',69.5),('baseA','base',439.0),('baseB','base',348.5)]
os.makedirs('out/solids',exist_ok=True)
fig,ax=plt.subplots(len(want),3,figsize=(9,3*len(want)))
for i,(k,l,v) in enumerate(want):
    t=trimesh.load(M+l+'_visual.stl',force='mesh')
    c=min((c for c in t.split(only_watertight=False) if c.is_watertight),key=lambda c:abs(abs(c.volume)*1e6-v))
    c.export(f'out/solids/{k}.stl'); h=.002; s,g=lighten.voxelize(f'out/solids/{k}.stl',h)
    print(k,c.bounds.round(4).tolist(),'filled',round(s.sum()/(c.volume/h**3),3),'fillratio bbox',round(s.mean(),3))
    for a in range(3):
        m=s.shape[a]//2; ax[i,a].imshow(np.take(s,m,axis=a).T,origin='lower'); ax[i,a].set_title(f'{k} midslice {a}',fontsize=8); ax[i,a].axis('off')
plt.tight_layout(); plt.savefig('out/solids.png',dpi=70)

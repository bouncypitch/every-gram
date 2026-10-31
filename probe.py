import trimesh, numpy as np, sys
from scipy import ndimage as ni
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
M='assets/data/robots/berkeley_humanoid/berkeley_humanoid_lite/meshes/'
names=['leg_left_knee_pitch','leg_left_hip_pitch','leg_left_ankle_roll','leg_left_ankle_pitch']
fig,ax=plt.subplots(len(names),3,figsize=(10,3*len(names)))
for i,n in enumerate(names):
    t=trimesh.load(M+n+'_visual.stl',force='mesh')
    comps=t.split(only_watertight=False)
    wt=[c for c in comps if c.is_watertight]
    print(n,'comps',len(comps),'watertight',len(wt),'wt vol cm3',round(sum(abs(c.volume) for c in wt)*1e6,1),'hull cm3',round(t.convex_hull.volume*1e6,1))
    p=0.0025
    g=t.voxelized(p).matrix
    f=ni.binary_fill_holes(ni.binary_closing(np.pad(g,2),iterations=1))
    print('  grid',f.shape,'surf',int(g.sum()),'filled',int(f.sum()),'filled cm3',round(f.sum()*p**3*1e6,1))
    for a in range(3):
        ax[i,a].imshow(f.sum(axis=a),cmap='magma'); ax[i,a].set_title(f'{n[9:]} axis{a}',fontsize=8); ax[i,a].axis('off')
plt.tight_layout(); plt.savefig('out/probe.png',dpi=80)

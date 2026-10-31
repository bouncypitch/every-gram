import numpy as np, lighten, time
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
M='assets/data/robots/berkeley_humanoid/berkeley_humanoid_lite/meshes/leg_left_ankle_pitch_visual.stl'
t=time.time(); h=.001; s,g=lighten.voxelize(M,h); print('vox',s.shape,int(s.sum()),'cm3',s.sum()*h**3*1e6,time.time()-t)
np.savez_compressed('out/hero.npz',s=s)
X,Y,Z=g
pitch=dict(p=[-.0131,0,.0274],d=[0,1,0]); roll=dict(p=[0,-.0024,-.0226],d=[1,0,0])
for nm,a in (('pitch',pitch),('roll',roll)):
    print(nm,[ (r,int((lighten.cyl(g,{**a,'r0':r-3e-3,'r1':r})&s).sum())) for r in (.003,.006,.009,.012,.015,.018,.021,.024,.03)])
fig,ax=plt.subplots(2,4,figsize=(14,7))
for i,y in enumerate((-.03,-.01,.01,.03)):
    j=np.argmin(abs(X[0,:,0][...]*0+Y[0,:,0]-y)); ax[0,i].imshow(s[:,j,:].T,origin='lower',extent=[X.min(),X.max(),Z.min(),Z.max()]); ax[0,i].plot(-.0131,.0274,'r+'); ax[0,i].axhline(-.0226,c='c'); ax[0,i].set_title(f'y={y}')
for i,x in enumerate((-.03,-.015,0,.012)):
    j=np.argmin(abs(X[:,0,0]-x)); ax[1,i].imshow(s[j,:,:].T,origin='lower',extent=[Y.min(),Y.max(),Z.min(),Z.max()]); ax[1,i].plot(-.0024,-.0226,'r+'); ax[1,i].axhline(.0274,c='c'); ax[1,i].set_title(f'x={x}')
plt.tight_layout(); plt.savefig('out/slices.png',dpi=70)

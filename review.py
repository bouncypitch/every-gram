"""Do the changes make sense? Checks that physics alone does not: bolt holes, thin walls, loose bits."""
import json,os,pickle,numpy as np,jobs,lighten
from scipy import ndimage as ni
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
def holes_rim(s,h,rim=.003,closing=.004):
    n=max(2,int(round(closing/h))); p=np.pad(s,n+1)
    c=ni.binary_closing(p,iterations=n)[n+1:-n-1,n+1:-n-1,n+1:-n-1]
    hl=c&~s; hl=ni.binary_opening(hl,iterations=1)
    lab,k=ni.label(hl); return hl,ni.binary_dilation(hl,iterations=max(1,int(round(rim/h))))&s,k
def thickness(d,h):
    dt=ni.distance_transform_edt(np.pad(d,1))[1:-1,1:-1,1:-1]
    op=ni.binary_opening(d,iterations=max(1,int(round(.001/h))))
    return float(1-op.sum()/d.sum())
def main():
    rows={}
    fig,ax=plt.subplots(4,3,figsize=(13,13))
    for r,k in enumerate(['yoke','foot','arm']):
        job=jobs.JOBS[k]; h=job['h']; s,g=lighten.voxelize(job['mesh'],h)
        c=[(n,f'out/{f}.pkl') for n,f in (('Topology','topo_'+k),('Honeycomb',f'pat_{k}_honeycomb'),('Isogrid',f'pat_{k}_isogrid'),('Hollow',f'pat_{k}_hollow'))]
        cand=[(n,pickle.load(open(f,'rb'))['best']) for n,f in c if os.path.exists(f)]; cand=[x for x in cand if x[1] is not None]
        n,b=min(cand,key=lambda x:x[1]['fill']); d=b['solid']
        hl,rimm,nh=holes_rim(s,h)
        rim_kept=float((d&rimm).sum()/max(rimm.sum(),1))
        lab,ncomp=ni.label(d); thin=thickness(d,h)
        rows[k]=dict(strategy=n,fill=b['fill'],holes=int(nh),rim_kept=rim_kept,pieces=int(ncomp),thin_fraction=thin)
        print(k,rows[k])
        for a in range(3):
            i=np.argmax((s&~d).sum(axis=tuple(x for x in range(3) if x!=a)))
            A=np.take(s,i,axis=a).astype(int)+np.take(d,i,axis=a).astype(int)
            ax[r,a].imshow(A.T,origin='lower',cmap='magma'); ax[r,a].set_title(f'{k} {n}: axis {a} (bright kept, dim removed)',fontsize=8); ax[r,a].axis('off')
    plt.tight_layout(); plt.savefig('out/review.png',dpi=70); json.dump(rows,open('out/review.json','w'),indent=1)
if __name__=='__main__': main()

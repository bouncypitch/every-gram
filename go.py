import time,jobs,lighten,numpy as np,pickle
t=time.time(); R=lighten.run(jobs.HERO); print('sec',round(time.time()-t,1))
if R['best']:
    d=R['best'][0]; print('mass ratio',d.sum()/R['solid'].sum())
pickle.dump({k:R[k] for k in('solid','fixed','load','base_peak','base_defl','limit','dlim')}|{'vm0':R['base']['vm'],'best':R['best'] and (R['best'][0],R['best'][1]['vm'],R['best'][2],R['best'][3])},open('out/hero.pkl','wb'))

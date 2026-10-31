import sys,pickle,time,jobs,lighten
k=sys.argv[1]; t=time.time(); R=lighten.run(jobs.JOBS[k],log=lambda m:print(k,m,flush=True))
R.pop('grid'); pickle.dump(R,open(f'out/{k}.pkl','wb')); print(k,'done',round(time.time()-t),'best',None if R['best'] is None else round(float(R['best']['solid'].sum()/R['solid'].sum()),3),flush=True)

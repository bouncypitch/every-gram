import numpy as np, time, fe
h=1e-3; F=100; E=2.5e9
s=np.ones((100,10,10),bool); fx=np.zeros_like(s); fx[0]=1; ld=np.zeros_like(s); ld[-1]=1
t=time.time(); r=fe.solve(s,h,E,.35,fx,[(ld,[0,0,-F])]); 
tip=np.abs(r['u'][2::3]).max()
L=.0995; I=.01**4/12
print('iters',r['iters'],'t',round(time.time()-t,1),'tip mm',tip*1e3,'theory',F*L**3/(3*E*I)*1e3)
print('sigma at x=25mm top MPa',r['vm'][25,5,9]/1e6,'theory',F*(L-.0255)*(.0045)/I/1e6)

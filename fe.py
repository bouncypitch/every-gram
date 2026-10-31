"""Voxel linear-elastic FE: 8-node hexes on a regular grid, Jacobi-preconditioned CG."""
import numpy as np, scipy.sparse as sp, scipy.sparse.linalg as sl

_C = np.array([[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]], float)

def _B(xi, h):
    d = np.stack([_C[:,i]*np.prod(1+np.delete(_C,i,1)*np.delete(xi,i),axis=1)/8 for i in range(3)],1)*2/h
    B = np.zeros((6,24))
    for a in range(8):
        x,y,z = d[a]; c = 3*a
        B[0,c]=x; B[1,c+1]=y; B[2,c+2]=z
        B[3,c]=y; B[3,c+1]=x; B[4,c+1]=z; B[4,c+2]=y; B[5,c]=z; B[5,c+2]=x
    return B

def _D(nu):
    l = nu/((1+nu)*(1-2*nu)); m = 1/(2*(1+nu))
    D = np.zeros((6,6)); D[:3,:3] = l; D[range(3),range(3)] += 2*m; D[range(3,6),range(3,6)] = m
    return D

def solve(solid, h, E, nu, fixed, loads, tol=1e-6, maxiter=20000, scale=None):
    """solid: bool grid. fixed: bool mask on elements whose nodes are clamped.
    loads: list of (element mask, force vector N) spread evenly over those nodes."""
    idx = np.argwhere(solid); ne = len(idx)
    sc = np.ones(ne) if scale is None else scale[solid]
    off = ((_C+1)/2).astype(int)
    nid_grid = np.array(solid.shape)+1
    raw = np.ravel_multi_index((idx[:,None,:]+off[None]).reshape(-1,3).T, nid_grid).reshape(ne,8)
    uniq, en = np.unique(raw, return_inverse=True); en = en.reshape(ne,8); nn = len(uniq)
    D = _D(nu); g = 1/np.sqrt(3)
    K0 = sum(_B(np.array(p)*g,h).T@D@_B(np.array(p)*g,h) for p in _C)*(h/2)**3
    dof = (en[:,:,None]*3+np.arange(3)).reshape(ne,24)
    K = sp.coo_matrix(((np.tile(K0.ravel(),ne)*E*np.repeat(sc,576)),(np.repeat(dof,24,1).ravel(),np.tile(dof,(1,24)).ravel())),shape=(3*nn,3*nn)).tocsr()
    f = np.zeros(3*nn)
    for mask, F in loads:
        n = np.unique(en[mask[solid]])
        f[(n[:,None]*3+np.arange(3)).ravel()] += np.tile(np.asarray(F)/len(n),len(n))
    fx = np.unique(en[fixed[solid]])
    free = np.ones(3*nn,bool); free[(fx[:,None]*3+np.arange(3)).ravel()] = False
    A = K[free][:,free]
    M = sp.diags(1/A.diagonal())
    u = np.zeros(3*nn); it = [0]
    x,info = sl.cg(A,f[free],M=M,rtol=tol,maxiter=maxiter,callback=lambda _: it.__setitem__(0,it[0]+1))
    u[free] = x
    Bc = _B(np.zeros(3),h)
    s = ((E*D@Bc)@u[dof].T)*sc
    sx,sy,sz,txy,tyz,tzx = s
    vm = np.sqrt(.5*((sx-sy)**2+(sy-sz)**2+(sz-sx)**2)+3*(txy**2+tyz**2+tzx**2))
    out = np.zeros(solid.shape); out[solid] = vm
    return dict(vm=out, u=u, en=en, nodes=uniq, iters=it[0], info=info, n_el=ne)

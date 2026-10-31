import xml.etree.ElementTree as ET, glob, os, trimesh
u='assets/data/robots/berkeley_humanoid/berkeley_humanoid_lite/urdf/berkeley_humanoid_lite.urdf'
r=ET.parse(u).getroot(); tot=0; rows=[]
for l in r.findall('link'):
    m=l.find('inertial/mass'); v=float(m.get('value')) if m is not None else 0
    tot+=v
    mesh=l.find('visual/geometry/mesh')
    rows.append((v,l.get('name'),mesh.get('filename') if mesh is not None else None))
for v,n,f in sorted(rows,reverse=True)[:30]: print(f'{v:.3f}',n,f)
print('links',len(rows),'total',round(tot,3))
for f in sorted(glob.glob('assets/**/*.stl',recursive=True)+glob.glob('assets/**/*.STL',recursive=True)):
    t=trimesh.load(f,force='mesh')
    print(os.path.relpath(f,'assets'),len(t.faces),t.is_watertight,t.extents.round(4),round(float(t.volume),7) if t.is_watertight else None)

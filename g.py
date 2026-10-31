import trimesh, numpy as np, xml.etree.ElementTree as ET
M='assets/data/robots/berkeley_humanoid/berkeley_humanoid_lite/meshes/leg_left_ankle_pitch_visual.stl'
t=trimesh.load(M,force='mesh')
print('bounds',t.bounds.round(4).tolist(),'wt',t.is_watertight)
for c in t.split(only_watertight=False): print(' comp',len(c.faces),c.is_watertight,round(c.volume*1e6,2),c.bounds.round(4).tolist())
r=ET.parse('assets/data/robots/berkeley_humanoid/berkeley_humanoid_lite/urdf/berkeley_humanoid_lite.urdf').getroot()
for j in r.findall('joint'):
    if 'left_ankle' in j.get('name'):
        print(j.get('name'),j.get('type'),j.find('parent').get('link'),j.find('child').get('link'),j.find('origin').attrib,(j.find('axis').attrib if j.find('axis') is not None else None),(j.find('limit').attrib if j.find('limit') is not None else None))
l=[x for x in r.findall('link') if x.get('name')=='leg_left_ankle_pitch'][0]
print(ET.tostring(l.find('inertial')).decode()[:300]); print(ET.tostring(l.find('visual')).decode()[:300])

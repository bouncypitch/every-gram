import xml.etree.ElementTree as ET
D='assets/data/robots/berkeley_humanoid/berkeley_humanoid_lite/urdf/'
def L(f):
    r=ET.parse(D+f).getroot(); return {l.get('name'):float(l.find('inertial/mass').get('value')) if l.find('inertial/mass') is not None else 0 for l in r.findall('link')},[j for j in r.findall('joint') if j.get('type')=='revolute']
a,ja=L('berkeley_humanoid_lite.urdf'); b,jb=L('berkeley_humanoid_lite_biped.urdf')
print('full',round(sum(a.values()),3),'joints',len(ja),'| biped',round(sum(b.values()),3),'joints',len(jb))
print('arm links',round(sum(v for k,v in a.items() if k.startswith('arm')),3),'leg',round(sum(v for k,v in a.items() if k.startswith('leg')),3),'base',a['base'],'base biped',b.get('base'))

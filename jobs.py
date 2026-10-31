M='assets/data/robots/berkeley_humanoid/berkeley_humanoid_lite/meshes/'
W=16.331*9.81*3   # 3 x body weight through one ankle (assumption)
S='out/solids/'
C=dict(h=.0012,E=2.5e9,nu=.35,rho=1346,allowable=20e6,max_deflection_ratio=1.10,skin=.0015,cell=.012,boss=3,steps=6)
JOBS={
 'yoke':{**C,'h':.001,'steps':7,'mesh':M+'leg_left_ankle_pitch_visual.stl','links':['leg_left_ankle_pitch','leg_right_ankle_pitch'],
   'supports':[dict(p=[-.0131,0,.0274],d=[0,1,0],r0=.017,r1=.025)],
   'cases':[[dict(p=[0,-.0024,-.0226],d=[1,0,0],r0=.017,r1=.026,xmin=.005,F=[0,0,W])]],'load_note':'3 x body weight through ankle'},
 'foot':{**C,'h':.0015,'cell':.016,'skin':.002,'mesh':S+'foot.stl','links':['leg_left_ankle_roll','leg_right_ankle_roll'],
   'supports':[dict(zmin=0.0)],
   'cases':[[dict(xmin=.075,zmax=-.022,F=[0,0,W])],[dict(xmax=-.100,zmax=-.022,F=[0,0,W])]],'load_note':'3 x body weight on toe, then on heel'},
 'arm':{**C,'mesh':S+'arm.stl','links':['arm_left_shoulder_roll','arm_right_shoulder_roll','arm_left_elbow_pitch','arm_right_elbow_pitch'],
   'supports':[dict(zmin=.078)],
   'cases':[[dict(zmax=.016,F=[250,0,0])],[dict(zmax=.016,F=[0,250,0])]],'load_note':'250 N side load, from 20 N m joint limit at 80 mm'},
 'hip':{**C,'mesh':S+'hip.stl','links':['leg_left_hip_roll','leg_right_hip_roll','leg_left_hip_yaw','leg_right_hip_yaw'],
   'supports':[dict(zmin=.035)],
   'cases':[[dict(zmax=-.038,F=[0,0,W])],[dict(zmax=-.038,F=[W/2,0,0])]],'load_note':'3 x body weight axial, 1.5 x side'},
}

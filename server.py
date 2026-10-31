"""Live API for any product link. One job at a time; capped total jobs."""
import json,os,re,threading,time,uuid,traceback,mimetypes
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
import product as P, trimesh
os.makedirs('out/web',exist_ok=True)
JOBS={}; LOCK=threading.Lock(); COUNT=[0]; MAX=60
def work(j,info):
    J=JOBS[j]; log=J['log'].append
    try:
        log('Downloading CAD'); path=P.fetch_cad(info['cad_url'],j)
        t=trimesh.load(path,force='mesh'); log(f'Model loaded: {len(t.faces)} faces, {(t.extents*1e3).round(1).tolist()} (file units)')
        if t.extents.max()>2: t.apply_scale(.001); log('Scaled millimetres to metres')
        fx=f'out/web/{j}_m.stl'; t.export(fx)
        log('Claude is setting up the test'); c=P.load_case(info,t); log(c.get('assumption',''))
        R=P.optimize(fx,info['material'],float(info['load_n']),c,log)
        if R['best'] is None: raise ValueError('No lighter design passed the same stress and stiffness limits')
        J['result']=P.write_result(j,R,info,c,info['material']); J['result']={k:(float(v) if hasattr(v,'dtype') else v) for k,v in J['result'].items()}
        J['files']={k:f'/files/{j}/{v}' for k,v in dict(before='before.glb',after='after.glb',stl='design.stl').items()}
        J['status']='done'
    except Exception as e:
        traceback.print_exc(); J['status']='error'; J['message']=str(e)[:300]
    finally: LOCK.release()
class H(BaseHTTPRequestHandler):
    def _s(self,o,c=200):
        b=json.dumps(o).encode(); self.send_response(c); self.send_header('content-type','application/json'); self._cors(); self.send_header('content-length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def _cors(self):
        self.send_header('access-control-allow-origin','*'); self.send_header('access-control-allow-headers','content-type')
    def do_OPTIONS(self): self.send_response(204); self._cors(); self.end_headers()
    def log_message(self,*a): pass
    def do_GET(self):
        m=re.fullmatch(r'/api/job/([0-9a-f]{12})',self.path)
        if m and m[1] in JOBS: return self._s(JOBS[m[1]])
        m=re.fullmatch(r'/files/([0-9a-f]{12})/(before\.glb|after\.glb|design\.stl)',self.path)
        if m and os.path.exists(p:=f'out/web/{m[1]}_result/{m[2]}'):
            b=open(p,'rb').read(); self.send_response(200); self.send_header('content-type',mimetypes.guess_type(p)[0] or 'application/octet-stream'); self._cors(); self.send_header('content-disposition','attachment; filename=every-gram-'+m[2]); self.send_header('content-length',str(len(b))); self.end_headers(); self.wfile.write(b); return
        self._s(dict(status='error',message='not found'),404)
    def do_POST(self):
        if self.path!='/api/analyze': return self._s(dict(status='error',message='not found'),404)
        try:
            n=min(int(self.headers.get('content-length',0)),10000); q=json.loads(self.rfile.read(n))
            if COUNT[0]>=MAX: return self._s(dict(status='error',message='Demo job limit reached'))
            ov=q.get('overrides') or {}; info=P.read_page(q['url'],{k:ov.get(k) for k in('load_n','material','cad_url')})
            miss=[k for k in('cad_url','material','load_n') if not info.get(k)]
            if info.get('material') not in P.MATERIALS and 'material' not in miss: miss.append('material')
            try: bad=not 0<float(info.get('load_n') or 1)<1e6
            except: bad=True
            if bad: miss.append('load_n')
            if miss: return self._s(dict(status='needs_input',info=info,missing=miss,materials=list(P.MATERIALS),message='This page does not give everything the physics needs.'))
            if not LOCK.acquire(blocking=False): return self._s(dict(status='error',message='Another design is running. Try again in a minute.'))
            COUNT[0]+=1; j=uuid.uuid4().hex[:12]; JOBS[j]=dict(status='running',log=[f'Read {info.get("name")}'],info=info)
            threading.Thread(target=work,args=(j,info),daemon=True).start(); self._s(dict(status='running',job=j))
        except Exception as e:
            traceback.print_exc(); self._s(dict(status='error',message=str(e)[:300]))
ThreadingHTTPServer(('127.0.0.1',8787),H).serve_forever()

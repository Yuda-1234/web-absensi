// Backend absensi J&T Express: Node.js + MySQL (mysql2). Butuh: npm install mysql2 dotenv
require('dotenv').config();
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const pool=require('./db');
const UPLOAD=path.join(__dirname,'uploads');fs.mkdirSync(UPLOAD,{recursive:true}); // foto kehadiran disimpan di sini
const q=async(sql,p=[])=>(await pool.query(sql,p))[0];
const one=async(sql,p=[])=>(await q(sql,p))[0];
const hash=p=>{const s=crypto.randomBytes(16).toString('hex');return s+':'+crypto.scryptSync(p,s,32).toString('hex')};
const check=(p,h)=>{const[s,x]=h.split(':');return crypto.timingSafeEqual(crypto.scryptSync(p,s,32),Buffer.from(x,'hex'))};
const S=new Map(),cfg=()=>one('SELECT * FROM pengaturan WHERE id=1');
const now=()=>{const[d,t]=new Date().toLocaleString('sv-SE',{timeZone:'Asia/Jakarta'}).split(' ');return{d,t}};
const jarak=(a,b,x,y)=>{const p=Math.PI/180,A=(x-a)*p,B=(y-b)*p,k=Math.sin(A/2)**2+Math.cos(a*p)*Math.cos(x*p)*Math.sin(B/2)**2;return 12742000*Math.asin(Math.sqrt(k))};
const need=(u,r)=>{if(!u)throw[401,'Belum login'];if(r&&u.role!==r)throw[403,'Tidak diizinkan']};
const str=(v,max=100)=>String(v??'').trim().slice(0,max);
const num=v=>{const n=typeof v==='number'?v:parseFloat(v);return Number.isFinite(n)?n:null};
const koord=b=>{const lat=num(b.lat),lng=num(b.lng);
 if((lat!==null&&Math.abs(lat)>90)||(lng!==null&&Math.abs(lng)>180))throw[400,'Koordinat tidak valid'];
 return{lat,lng}};

// ===== Jabatan & shift =====
const JABATAN=['SPV','KOORDINATOR','ADMIN','PROCESSING REGULER','PROCESSING FREELANCE','TRANSPORTER','TEAM PICKUP','Lainnya'];
const SHIFT={
 pagi:{nama:'Pagi',mulai:'09:00',selesai:'16:00'},
 siang:{nama:'Siang',mulai:'15:00',selesai:'03:00'},
 malam:{nama:'Malam',mulai:'19:00',selesai:'07:00'}
};
const jabatanVal=b=>{const j=str(b.jabatan,30);if(!JABATAN.includes(j))throw[400,'Pilih jabatan yang valid'];
 if(j!=='Lainnya')return j;const l=str(b.jabatan_lain,40);if(!l)throw[400,'Sebutkan jabatan lainnya'];return'Lainnya - '+l};
const mnt=s=>{const[h,m]=s.split(':');return+h*60+ +m};
// Terlambat bila masuk 1 menit sampai 12 jam setelah jam mulai shift; lebih awal dari itu dianggap tepat waktu
const statusMasuk=(sh,t)=>{const d=(mnt(t.slice(0,5))-mnt(SHIFT[sh].mulai)+1440)%1440;return d>0&&d<=720?'Terlambat':'Tepat Waktu'};

// ===== Foto kehadiran (JPEG dari kamera, sudah dibubuhi cap waktu & lokasi di browser) =====
const simpanFoto=(uid,d,aksi,data)=>{
 const m=/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(data||''));
 if(!m)throw[400,'Foto kehadiran wajib diambil'];
 const buf=Buffer.from(m[1],'base64');
 if(buf.length<2000||buf.length>2e6||buf[0]!==0xFF||buf[1]!==0xD8)throw[400,'Foto tidak valid atau terlalu besar'];
 const nama=`${uid}-${d}-${aksi}-${crypto.randomBytes(4).toString('hex')}.jpg`;
 fs.writeFileSync(path.join(UPLOAD,nama),buf);return nama};

const rekap=bl=>q(`SELECT a.id,u.nama,u.jabatan,a.tanggal,a.shift,a.jam_masuk,a.jam_pulang,a.status,a.lat,a.lng,a.lat_pulang,a.lng_pulang,
 (a.foto_masuk IS NOT NULL) AS fm,(a.foto_pulang IS NOT NULL) AS fp
 FROM absensi a JOIN users u ON u.id=a.user_id WHERE LEFT(a.tanggal,7)=? ORDER BY a.tanggal DESC,u.nama`,[bl]);

async function seed(){
 if(!(await one('SELECT 1 FROM users LIMIT 1'))){
  const ins='INSERT INTO users(nama,username,password,jabatan,role) VALUES(?,?,?,?,?)';
  await q(ins,['Administrator','admin',hash('admin123'),'HRD','admin']);
  await q(ins,['Budi Santoso','budi',hash('123456'),'Kurir','karyawan']);
 }
 if(!(await one('SELECT 1 FROM pengaturan WHERE id=1')))
  await q('INSERT INTO pengaturan(id,lat,lng,radius) VALUES(1,?,?,?)',[-6.2088,106.8456,0]); // radius 0 = validasi lokasi nonaktif
}

const api={
'POST /api/login':async({b})=>{const u=await one('SELECT * FROM users WHERE username=? AND aktif=1',[str(b.username)]);
 if(!u||!check(String(b.password||''),u.password))throw[401,'Username atau password salah'];
 const t=crypto.randomBytes(24).toString('hex');S.set(t,u.id);return{cookie:`sid=${t}; HttpOnly; SameSite=Strict; Path=/`,data:{nama:u.nama,role:u.role}}},
'POST /api/logout':async({sid})=>{S.delete(sid);return{cookie:'sid=; Max-Age=0; Path=/',data:{ok:1}}},
'GET /api/me':async({user})=>{need(user);return{nama:user.nama,username:user.username,role:user.role,jabatan:user.jabatan,waktu:Date.now(),shift:SHIFT,jabatan_list:JABATAN}},

'POST /api/absen':async({user,b})=>{need(user,'karyawan');const c=await cfg(),{d,t}=now(),{lat,lng}=koord(b);
 if(c.radius>0){if(lat===null||lng===null)throw[400,'LOKASI_DIPERLUKAN'];if(!(jarak(lat,lng,c.lat,c.lng)<=c.radius))throw[400,'Anda berada di luar radius kantor']}
 if(b.aksi==='masuk'){
  if(!SHIFT[b.shift])throw[400,'Pilih shift terlebih dahulu'];
  if(await one('SELECT 1 FROM absensi WHERE user_id=? AND tanggal=?',[user.id,d]))throw[400,'Sudah absen masuk hari ini'];
  const foto=simpanFoto(user.id,d,'masuk',b.foto),st=statusMasuk(b.shift,t);
  await q('INSERT INTO absensi(user_id,tanggal,shift,jam_masuk,status,lat,lng,foto_masuk) VALUES(?,?,?,?,?,?,?,?)',[user.id,d,b.shift,t,st,lat,lng,foto]);
  return{pesan:`Absen masuk berhasil (${st})`}}
 if(b.aksi==='pulang'){ // shift lewat tengah malam: absen pulang bisa jatuh di hari berikutnya, jadi cari yang masih terbuka hari ini / kemarin
  const kemarin=new Date(Date.parse(d+'T00:00:00Z')-864e5).toISOString().slice(0,10);
  const o=await one('SELECT id FROM absensi WHERE user_id=? AND jam_masuk IS NOT NULL AND jam_pulang IS NULL AND tanggal IN (?,?) ORDER BY tanggal DESC LIMIT 1',[user.id,d,kemarin]);
  if(!o)throw[400,'Belum absen masuk atau sudah pulang'];
  const foto=simpanFoto(user.id,d,'pulang',b.foto);
  await q('UPDATE absensi SET jam_pulang=?,lat_pulang=?,lng_pulang=?,foto_pulang=? WHERE id=?',[t,lat,lng,foto,o.id]);
  return{pesan:'Absen pulang berhasil'}}
 throw[400,'Aksi tidak valid']},
'GET /api/riwayat':async({user})=>{need(user,'karyawan');return q(`SELECT id,tanggal,shift,jam_masuk,jam_pulang,status,lat,lng,lat_pulang,lng_pulang,
 (foto_masuk IS NOT NULL) AS fm,(foto_pulang IS NOT NULL) AS fp FROM absensi WHERE user_id=? ORDER BY tanggal DESC LIMIT 31`,[user.id])},
'GET /api/foto/:id':async({user,id,url})=>{need(user);const kol=url.searchParams.get('jenis')==='pulang'?'foto_pulang':'foto_masuk';
 const r=await one(`SELECT user_id,${kol} AS f FROM absensi WHERE id=?`,[id]);
 if(!r||!r.f||!/^[\w.-]+$/.test(r.f))throw[404,'Foto tidak ditemukan'];
 if(user.role!=='admin'&&r.user_id!==user.id)throw[403,'Tidak diizinkan'];
 let file;try{file=fs.readFileSync(path.join(UPLOAD,r.f))}catch{throw[404,'Foto tidak ditemukan']}
 return{file,type:'image/jpeg'}},

'PUT /api/akun':async({user,b})=>{need(user,'karyawan');await q('UPDATE users SET jabatan=? WHERE id=?',[jabatanVal(b),user.id]);return{pesan:'Jabatan disimpan'}},
'POST /api/password':async({user,b})=>{need(user);if(String(b.password||'').length<6)throw[400,'Password minimal 6 karakter'];await q('UPDATE users SET password=? WHERE id=?',[hash(b.password),user.id]);return{pesan:'Password diubah'}},

'POST /api/izin':async({user,b})=>{need(user,'karyawan');if(!['Sakit','Izin','Cuti'].includes(b.jenis)||!/^\d{4}-\d\d-\d\d$/.test(b.tanggal||'')||!str(b.ket))throw[400,'Data izin tidak lengkap'];
 await q('INSERT INTO izin(user_id,tanggal,jenis,keterangan) VALUES(?,?,?,?)',[user.id,b.tanggal,b.jenis,str(b.ket,300)]);return{pesan:'Pengajuan terkirim'}},
'GET /api/izin':async({user})=>{need(user);return user.role==='admin'?q('SELECT i.*,u.nama FROM izin i JOIN users u ON u.id=i.user_id ORDER BY i.id DESC'):q('SELECT * FROM izin WHERE user_id=? ORDER BY id DESC LIMIT 10',[user.id])},
'PUT /api/izin/:id':async({user,b,id})=>{need(user,'admin');if(!['Disetujui','Ditolak'].includes(b.status))throw[400,'Status tidak valid'];await q('UPDATE izin SET status=? WHERE id=?',[b.status,id]);return{ok:1}},

'GET /api/karyawan':async({user})=>{need(user,'admin');return q("SELECT id,nama,jabatan,username FROM users WHERE role='karyawan' AND aktif=1")},
'POST /api/karyawan':async({user,b})=>{need(user,'admin');if(!str(b.nama)||!str(b.username)||String(b.password||'').length<6)throw[400,'Nama, username, dan password (min 6 karakter) wajib diisi'];
 const jab=jabatanVal(b);
 try{await q('INSERT INTO users(nama,username,password,jabatan) VALUES(?,?,?,?)',[str(b.nama),str(b.username,50),hash(b.password),jab])}catch{throw[400,'Username sudah dipakai']}return{ok:1}},
'DELETE /api/karyawan/:id':async({user,id})=>{need(user,'admin');await q("UPDATE users SET aktif=0 WHERE id=? AND role='karyawan'",[id]);return{ok:1}},

'GET /api/ringkasan':async({user})=>{need(user,'admin');const{d}=now(),n=async(sql,p=[])=>(await one(sql,p)).c;
 return{karyawan:await n("SELECT COUNT(*) c FROM users WHERE role='karyawan' AND aktif=1"),hadir:await n('SELECT COUNT(*) c FROM absensi WHERE tanggal=?',[d]),
  terlambat:await n("SELECT COUNT(*) c FROM absensi WHERE tanggal=? AND status='Terlambat'",[d]),izin:await n("SELECT COUNT(*) c FROM izin WHERE status='Menunggu'")}},
'GET /api/rekap':async({user,url})=>{need(user,'admin');return rekap(url.searchParams.get('bulan')||now().d.slice(0,7))},
'GET /api/rekap.csv':async({user,url})=>{need(user,'admin');const bl=url.searchParams.get('bulan')||now().d.slice(0,7);
 const c=v=>'"'+String(v??'').replace(/"/g,'""')+'"',aman=v=>/^[=+\-@]/.test(String(v??''))?"'"+v:v,loc=(a,b)=>a==null||b==null?'':`${a},${b}`;
 const rows=await rekap(bl);
 return{csv:'﻿NAMA;JABATAN;TANGGAL;SHIFT;MASUK;PULANG;STATUS;LOKASI MASUK;LOKASI PULANG\n'+rows.map(r=>[aman(r.nama),aman(r.jabatan),r.tanggal,SHIFT[r.shift]?.nama||'',r.jam_masuk,r.jam_pulang,r.status,loc(r.lat,r.lng),loc(r.lat_pulang,r.lng_pulang)].map(c).join(';')).join('\n'),nama:`rekap-${bl.replace(/[^\d-]/g,'')}.csv`}},
'GET /api/pengaturan':async({user})=>{need(user,'admin');return cfg()},
'PUT /api/pengaturan':async({user,b})=>{need(user,'admin');const{lat,lng}=koord(b);
 await q('UPDATE pengaturan SET lat=?,lng=?,radius=? WHERE id=1',[lat??0,lng??0,Math.max(0,parseInt(b.radius)||0)]);return{pesan:'Pengaturan disimpan'}}
};
const FILES={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js'};
const TYPES={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const J=(res,c,o,h={})=>{res.writeHead(c,{'Content-Type':'application/json',...h});res.end(JSON.stringify(o))};

seed().then(()=>{
 http.createServer((req,res)=>{const url=new URL(req.url,'http://x');let raw='';
  req.on('data',d=>{raw+=d;if(raw.length>3e6)req.destroy()}); // batas ±3 MB (foto JPEG base64)
  req.on('end',async()=>{try{
   if(req.method==='GET'&&!url.pathname.startsWith('/api/')){
    const n=FILES[url.pathname];if(!n)throw[404,'Tidak ditemukan'];
    res.writeHead(200,{'Content-Type':TYPES[path.extname(n)],'Cache-Control':'no-cache'});return res.end(fs.readFileSync(path.join(__dirname,'public',n)))}
   let b={};try{b=raw?JSON.parse(raw):{}}catch{throw[400,'JSON tidak valid']}
   const sid=(req.headers.cookie||'').match(/sid=(\w+)/)?.[1];
   const user=sid&&S.has(sid)?await one('SELECT * FROM users WHERE id=? AND aktif=1',[S.get(sid)]):null;
   const fn=api[req.method+' '+url.pathname.replace(/\d+$/,':id')];if(!fn)throw[404,'Tidak ditemukan'];
   const out=(await fn({user,b,url,sid,id:+(url.pathname.match(/(\d+)$/)||[])[1]}))||{ok:1};
   if(out.file){res.writeHead(200,{'Content-Type':out.type,'Cache-Control':'private, max-age=3600'});return res.end(out.file)}
   if(out.csv){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename=${out.nama||'rekap.csv'}`});return res.end(out.csv)}
   if(out.cookie)return J(res,200,out.data,{'Set-Cookie':out.cookie});
   J(res,200,out)}catch(e){if(Array.isArray(e))J(res,e[0],{error:e[1]});else{console.error(e);J(res,500,{error:'Kesalahan server'})}}})
 }).listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('Absensi berjalan di http://localhost:'+(process.env.PORT||3000)));
}).catch(e=>{console.error('Gagal terhubung ke database:',e.message);process.exit(1)});
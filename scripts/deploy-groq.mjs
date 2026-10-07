import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { config } from './filnet-connection.mjs';
const files=process.argv[3]==='ui' ? ['public/index.html','public/style.css','public/app.js'] : ['server.js','lib/settings.js','lib/telegram.js','lib/ai.js','lib/ssh.js','lib/manager.js','public/app.js','public/index.html'];
const client=new ssh2.Client();
await new Promise((resolve,reject)=>{client.on('ready',resolve).on('error',reject).connect({...config,readyTimeout:12000,hostVerifier:key=>'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'')===config.fingerprint});});
try {
 const sftp=await new Promise((resolve,reject)=>client.sftp((e,s)=>e?reject(e):resolve(s)));
 if(process.argv[2]==='review') {
  await fs.mkdir('data/groq-deploy-review',{recursive:true});
  for(const f of files){try{await new Promise((resolve,reject)=>sftp.fastGet('/Projects/pm2m/'+f,'data/groq-deploy-review/'+f.replaceAll('/','_'),e=>e?reject(e):resolve())); console.log('READ '+f);}catch(e){if(e.code===2)console.log('NEW '+f);else throw e;}}
 } else if(process.argv[2]==='stage') {
  const dir='/Projects/pm2m/.deploy-groq-'+new Date().toISOString().replace(/[:.]/g,'-');
  const mkdir=d=>new Promise((resolve,reject)=>sftp.mkdir(d,{mode:0o700},e=>e?reject(e):resolve()));
  await mkdir(dir);await mkdir(dir+'/lib');await mkdir(dir+'/public');
  const manifest={dir,files:[]};
  for(const f of files){await new Promise((resolve,reject)=>sftp.fastPut(f,dir+'/'+f,e=>e?reject(e):resolve()));manifest.files.push({file:f,sha256:createHash('sha256').update(await fs.readFile(f)).digest('hex')});}
  await fs.writeFile('data/groq-deploy-review/manifest.json',JSON.stringify(manifest,null,2));console.log('STAGED '+dir);
 }
}finally{client.end();}

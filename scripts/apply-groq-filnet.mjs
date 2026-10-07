import fs from 'node:fs/promises';
import { execute, quote } from '../lib/ssh.js';
import { config } from './filnet-connection.mjs';
const manifest=JSON.parse(await fs.readFile('data/groq-deploy-review/manifest.json','utf8'));
const source=`
const fs=require('fs'), path=require('path'), crypto=require('crypto'), cp=require('child_process');
const root='/Projects/pm2m', m=${JSON.stringify(manifest)}, node='/root/.nvm/versions/node/v22.16.0/bin/node', pm2='/root/.nvm/versions/node/v10.13.0/lib/node_modules/pm2/bin/pm2';
const env={...process.env,PATH:path.dirname(node)+':'+process.env.PATH};
const run=(args)=>cp.execFileSync(node,[pm2,...args],{env,encoding:'utf8'});
if(fs.realpathSync(root)!==root || !m.dir.startsWith(root+'/.deploy-groq-'))throw Error('Unexpected root');
const list=JSON.parse(run(['jlist'])); const p=list.find(p=>p.name==='pm2m'&&p.pm2_env.pm_exec_path===root+'/server.js');
if(!p || p.pm2_env.status!=='online')throw Error('Panel not online');
for(const f of m.files){const file=m.dir+'/'+f.file;if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==f.sha256)throw Error('Hash mismatch');if(f.file.endsWith('.js'))cp.execFileSync(node,['--check',file]);}
const backup=m.dir+'/backup';fs.mkdirSync(backup,{mode:0o700});
for(const f of m.files){const old=root+'/'+f.file;if(fs.existsSync(old)){const dest=backup+'/'+f.file;fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.copyFileSync(old,dest);}}
try {
for(const f of m.files){const dest=root+'/'+f.file;fs.copyFileSync(m.dir+'/'+f.file,dest+'.groq-new');fs.renameSync(dest+'.groq-new',dest);}
if(m.files.some(f=>!f.file.startsWith('public/')))run(['restart',String(p.pm_id)]);
console.log(JSON.stringify({updated:m.files.map(f=>f.file),process:p.pm_id,backup}));
} catch(e){for(const f of m.files){const old=backup+'/'+f.file;if(fs.existsSync(old))fs.copyFileSync(old,root+'/'+f.file);}try{if(m.files.some(f=>!f.file.startsWith('public/')))run(['restart',String(p.pm_id)]);}catch{}throw Error('Deployment failed; original files restored');}
`;
console.log(await execute(config, '/root/.nvm/versions/node/v22.16.0/bin/node -e '+quote(source)));

import {execute,quote} from '../lib/ssh.js';
import {config} from './filnet-connection.mjs';
const source=`
(async()=>{
process.loadEnvFile('/Projects/pm2m/.env');
const base='http://127.0.0.1:'+(process.env.PORT||3100);
const home=await fetch(base);const html=await home.text();if(!home.ok||!html.includes('id="ai-form"'))throw Error('New UI missing');
const headers={'Content-Type':'application/json','X-PM2M-Request':'1'};
const login=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({password:process.env.ADMIN_PASSWORD})});if(!login.ok)throw Error('Login failed');
headers.Cookie=login.headers.get('set-cookie').split(';')[0];
try {
const ai=await (await fetch(base+'/api/ai',{headers})).json();
const tg=await (await fetch(base+'/api/telegram',{headers})).json();
if(!ai.config||!tg.config)throw Error('API unavailable');
console.log(JSON.stringify({http:home.status,groq:ai.config,telegram:{running:tg.status.running,error:tg.status.error||'',subscriptions:tg.config.subscriptions.length}}));
}finally{await fetch(base+'/api/logout',{method:'POST',headers,body:'{}'});}
try{const r=await fetch('https://api.groq.com/openai/v1/models',{signal:AbortSignal.timeout(10000)});console.log('Groq network HTTP '+r.status);}catch{console.log('Groq network unavailable');}
})().catch(()=>{console.error('Health verification failed');process.exitCode=1});
`;
console.log(await execute(config,'/root/.nvm/versions/node/v22.16.0/bin/node -e '+quote(source)));

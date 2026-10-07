import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeGroq, redact, DEFAULT_MODEL } from '../lib/ai.js';
import { createSettings } from '../lib/settings.js';
import { createTelegram } from '../lib/telegram.js';

const apiKey = 'gsk_' + 'k'.repeat(40);
test('Groq key is encrypted, retained on blank edit, hidden publicly and removable', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pm2m-ai-')); t.after(() => rm(dir, {recursive:true, force:true}));
  const s = await createSettings(dir);
  await assert.rejects(s.saveAi({enabled:true}), /ключ/);
  await s.saveAi({enabled:true, apiKey, model:DEFAULT_MODEL});
  assert.equal(s.ai().apiKey, undefined);
  assert.equal((await readFile(path.join(dir,'settings.json'),'utf8')).includes(apiKey),false);
  await s.saveAi({enabled:true, apiKey:'', model:DEFAULT_MODEL});
  assert.equal((await createSettings(dir)).ai(true).apiKey,apiKey);
  await s.saveAi({enabled:false, clearKey:true}); assert.equal(s.ai().hasKey,false);
});
test('Groq request redacts secrets, sets bounds and never uses tools', async () => {
  const answer = await analyzeGroq({enabled:true,apiKey,model:DEFAULT_MODEL}, `password=hunter2 Bearer abcdef ${apiKey}`, undefined, async (url, options) => {
    assert.equal(url,'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.headers.Authorization,`Bearer ${apiKey}`);
    const body = JSON.parse(options.body);
    assert.equal(body.tools,undefined); assert.equal(body.max_completion_tokens,1800);
    assert.ok(!options.body.includes('hunter2')); assert.ok(!options.body.includes(apiKey));
    return {ok:true,json:async()=>({choices:[{message:{content:'Вероятно: ' + apiKey}}]})};
  });
  assert.ok(!answer.includes(apiKey));
  for(const status of [401,429,500]) await assert.rejects(analyzeGroq({enabled:true,apiKey,model:DEFAULT_MODEL},'',undefined,async()=>({ok:false,status})), /Groq/);
  await assert.rejects(analyzeGroq({enabled:true,apiKey},'',undefined,async()=>{throw Error(apiKey)}), e=>!e.message.includes(apiKey));
  assert.ok(!redact('https://admin:password@host Authorization: Bearer token').includes('password'));
});
test('stderr analysis requires authorized click, excludes stdout, caches and disables safely', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pm2m-ai-bot-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const settings = await createSettings(dir), calls=[]; let count=0;
  await settings.saveAi({enabled:true,apiKey,model:DEFAULT_MODEL});
  await settings.saveTelegram({enabled:true,token:'12345:'+'x'.repeat(30),userIds:['123'],subscriptions:[{serverId:'local',name:'app',script:'/app.js'}]});
  const manager={list:async()=>[{id:0,name:'app',script:'/app.js',status:'online',restarts:0}],
    errorLogs:async()=>[{file:'/err',ids:[0],stream:'stderr',text:'Error password=secret123',cursor:{}},{file:'/out',ids:[0],stream:'stdout',text:'DO NOT TRANSMIT',cursor:{}}]};
  let finish;
  const bot=createTelegram({settings,resolveManager:async()=>manager,request:async(_,method,body)=>{
    calls.push({method,body}); if(method==='getMe')return{username:'test'}; return{};
  },analyze:async(config,context)=>{count++; assert.ok(!context.includes('secret123')); assert.ok(!context.includes('DO NOT TRANSMIT')); return new Promise(resolve=>{finish=resolve});}});
  t.after(()=>bot.stop()); await bot.start({background:false}); await bot.monitor(); assert.equal(count,0);
  const key=calls.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
  const click=(user=123)=>bot.handle({callback_query:{id:'q',data:key,from:{id:user},message:{chat:{id:user,type:'private'}}}});
  await click(999);assert.equal(count,0);
  const pending=click(); while(!finish) await new Promise(resolve=>setImmediate(resolve));
  await click(); assert.equal(count,1); finish('Проверить конфигурацию'); await pending;
  assert.match(calls.at(-1).body.text,/Проверить конфигурацию/);
  await click(); assert.equal(count,1);
  await settings.saveAi({enabled:false}); await click(); assert.match(calls.at(-1).body.text,/выключен/);
  await bot.start({background:false}); await click(); assert.match(calls.at(-1).body.text,/устарело/);
});

test('AI settings HTTP API enforces login and CSRF and hides API key', async t => {
  const { createServer } = await import('../server.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pm2m-ai-http-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const settings=await createSettings(dir);
  const server=createServer({settings,password:'test',resolveManager:async()=>({})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  const url=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url+'/api/ai')).status,401);
  const headers={'Content-Type':'application/json','X-PM2M-Request':'1'};
  const login=await fetch(url+'/api/login',{method:'POST',headers,body:JSON.stringify({password:'test'})});
  headers.Cookie=login.headers.get('set-cookie').split(';')[0];
  const payload=JSON.stringify({enabled:true,apiKey,model:DEFAULT_MODEL});
  assert.equal((await fetch(url+'/api/ai',{method:'POST',headers:{Cookie:headers.Cookie,'Content-Type':'application/json'},body:payload})).status,403);
  const save=await fetch(url+'/api/ai',{method:'POST',headers,body:payload});
  assert.equal(save.status,200); assert.ok(!(await save.text()).includes(apiKey));
  const data=await (await fetch(url+'/api/ai',{headers})).json();
  assert.equal(data.config.hasKey,true); assert.equal(data.config.apiKey,undefined);
});

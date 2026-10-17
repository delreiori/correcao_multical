import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchSystemStatus } from '../web/api.ts';

test('painel explica falha da plataforma sem tentar exibir corpo bruto',async(context)=>{
 context.mock.method(globalThis,'fetch',async()=>new Response('A server error has occurred. internal-details',{status:500}));
 await assert.rejects(fetchSystemStatus(''),error=>error instanceof Error&&/backend falhou.*500/.test(error.message)&&!error.message.includes('internal-details'));
});
test('painel mantém mensagem JSON de autenticação',async(context)=>{
 context.mock.method(globalThis,'fetch',async()=>Response.json({error:'Token inválido ou ausente'},{status:401}));
 await assert.rejects(fetchSystemStatus('wrong'),/Token inválido/);
});
test('artefato JavaScript publicado inicia e responde JSON sem depender de fontes TypeScript',async()=>{
 const compiledModule=await import(new URL('../api/handler.js',import.meta.url).href);
 assert.equal(typeof compiledModule.default,'function');
 const previousPanelToken=process.env.PANEL_TOKEN,previousDatabaseUrl=process.env.DATABASE_URL;
 delete process.env.PANEL_TOKEN;delete process.env.DATABASE_URL;
 const server=createServer((request,response)=>void compiledModule.default(request,response));server.listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
 const baseUrl=`http://127.0.0.1:${address.port}`;
 try{
  let response=await fetch(baseUrl+'/api/handler?route=status');assert.equal(response.status,503);assert.match((await response.json()).error,/PANEL_TOKEN/);
  process.env.PANEL_TOKEN='test-panel';
  response=await fetch(baseUrl+'/api/handler?route=status');assert.equal(response.status,401);assert.match((await response.json()).error,/Token/);
  response=await fetch(baseUrl+'/api/handler?route=status',{headers:{Authorization:'Bearer test-panel'}});assert.equal(response.status,503);assert.match((await response.json()).error,/DATABASE_URL/);
 }finally{
  if(previousPanelToken===undefined)delete process.env.PANEL_TOKEN;else process.env.PANEL_TOKEN=previousPanelToken;
  if(previousDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previousDatabaseUrl;
  await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
});


test('lease dura mais que a função Vercel para evitar ciclos simultâneos', async () => {
    const { readFile } = await import('node:fs/promises');
    const { FUNCTION_MAX_DURATION_SECONDS, CYCLE_TIME_BUDGET_MS, CYCLE_LEASE_SECONDS } = await import('../server/execution-limits.ts');
    const configuration = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    assert.equal(configuration.functions['api/handler.js'].maxDuration, FUNCTION_MAX_DURATION_SECONDS);
    assert.ok(CYCLE_TIME_BUDGET_MS < FUNCTION_MAX_DURATION_SECONDS * 1000);
    assert.ok(CYCLE_LEASE_SECONDS > FUNCTION_MAX_DURATION_SECONDS);
});

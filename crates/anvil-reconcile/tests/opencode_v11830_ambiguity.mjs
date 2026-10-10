// Disposable localhost SendTurn ambiguity probe for the pinned OpenCode v1.18.30.
import { createServer as createTcpServer, createConnection } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");

async function freePort() {
  const server = createTcpServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address();
  await new Promise((ok, fail) => server.close((error) => error ? fail(error) : ok()));
  return port;
}

async function api(url, method = "GET", body, timeoutMs = 10000) {
  const response = await fetch(url, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let payload = text;
  try { payload = text ? JSON.parse(text) : null; } catch { /* preserve non-JSON error bodies */ }
  return { status: response.status, body: payload };
}

async function waitFor(predicate, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await predicate(); if (last) return last; } catch { /* poll transient startup */ }
    await delay(100);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function readBody(request) {
  const chunks=[];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function responseText(text, id) {
  return {id,object:"response",created_at:0,status:"completed",incomplete_details:null,model:"anvil-scripted",output:[{id:`msg_${id}`,type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text,annotations:[]}]}],output_text:text,usage:{input_tokens:0,input_tokens_details:null,output_tokens:0,output_tokens_details:null,total_tokens:0}};
}

function streamResponse(response, value) {
  response.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache"});
  const item=value.output[0];
  const emit=(name,data)=>response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  emit("response.created",{type:"response.created",response:{id:value.id,object:"response",created_at:0,status:"in_progress",output:[]}});
  emit("response.output_item.added",{type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",content:[]}});
  emit("response.content_part.added",{type:"response.content_part.added",item_id:item.id,output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}});
  emit("response.output_text.delta",{type:"response.output_text.delta",item_id:item.id,output_index:0,content_index:0,delta:value.output_text});
  emit("response.output_text.done",{type:"response.output_text.done",item_id:item.id,output_index:0,content_index:0,text:value.output_text});
  emit("response.content_part.done",{type:"response.content_part.done",item_id:item.id,output_index:0,content_index:0,part:item.content[0]});
  emit("response.output_item.done",{type:"response.output_item.done",output_index:0,item});
  emit("response.completed",{type:"response.completed",response:value});
  response.end("data: [DONE]\n\n");
}

async function main() {
  const openCodePort=await freePort(), modelPort=await freePort();
  const temporary=await mkdtemp(`${tmpdir()}/anvil-opencode-spike-`);
  const home=resolve(temporary,"home"), configDir=resolve(temporary,"config"), workspace=resolve(temporary,"workspace");
  await Promise.all([mkdir(home,{recursive:true}),mkdir(configDir,{recursive:true}),mkdir(workspace,{recursive:true})]);
  const config=resolve(configDir,"opencode.jsonc");
  await writeFile(config,JSON.stringify({$schema:"https://opencode.ai/config.json",permission:"allow",model:"openai/anvil-scripted",provider:{openai:{name:"local SendTurn probe model",options:{baseURL:`http://127.0.0.1:${modelPort}/v1`,apiKey:"local-only"},models:{"anvil-scripted":{name:"fixture",tool_call:true}}}}}));
  const env={...process.env,HOME:home,XDG_CONFIG_HOME:resolve(home,".config"),XDG_CACHE_HOME:resolve(home,".cache"),XDG_DATA_HOME:resolve(home,".local/share"),XDG_STATE_HOME:resolve(home,".local/state"),OPENCODE_CONFIG:config,OPENCODE_CONFIG_DIR:configDir,OPENCODE_DISABLE_AUTOUPDATE:"1",OPENAI_API_KEY:"local-only"};
  const serverLog=openSync(resolve(temporary,"opencode.log"),"a");
  const modelRequests=[];
  let modelReleased=false, releaseWaiters=[];
  const modelServer=createHttpServer(async(request,response)=>{
    if(request.url==="/v1/models"||request.url==="/models"){
      response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({object:"list",data:[{id:"anvil-scripted",object:"model",created:0,owned_by:"anvil-spike"}]}));return;
    }
    if(request.url==="/__test/hold"&&request.method==="POST"){modelReleased=false;response.writeHead(204);response.end();return;}
    if(request.url==="/__test/release"&&request.method==="POST"){modelReleased=true;for(const release of releaseWaiters.splice(0))release();response.writeHead(204);response.end();return;}
    if(request.url!=="/v1/responses"&&request.url!=="/responses"){response.writeHead(404);response.end();return;}
    const payload=await readBody(request);
    const text=typeof payload.input==="string"?payload.input:JSON.stringify(payload.input??[]);
    const modelRequest={text,receivedAt:Date.now(),gated:text.includes("ANVIL-E2E:wait-for-release")&&!modelReleased,completed:false};
    modelRequests.push(modelRequest);
    if(modelRequest.gated) await new Promise((resolveRelease)=>releaseWaiters.push(resolveRelease));
    if(response.destroyed)return;
    modelRequest.completed=true;
    const value=responseText("deterministic SendTurn probe response",`resp_probe_${modelRequests.length}`);
    if(payload.stream===true)streamResponse(response,value);
    else{response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify(value));}
  });
  await new Promise((ok)=>modelServer.listen(modelPort,"127.0.0.1",ok));
  let server;
  const base=`http://127.0.0.1:${openCodePort}`;
  async function startServer(){
    server=spawn("opencode",["serve","--hostname","127.0.0.1","--port",String(openCodePort)],{cwd:workspace,env,stdio:["ignore",serverLog,serverLog],detached:true});
    await waitFor(async()=>(await api(`${base}/global/health`)).status===200,"OpenCode health");
  }
  async function messageRows(sessionId){
    const result=await api(`${base}/session/${sessionId}/message`);
    if(result.status!==200)throw new Error(`message query returned ${result.status}: ${JSON.stringify(result.body)}`);
    return Array.isArray(result.body)?result.body:result.body?.data??[];
  }
  const info=(row)=>row?.info??{};
  const hasUser=(rows,id)=>rows.some((row)=>info(row).id===id&&info(row).role==="user");
  const assistantRows=(rows,id)=>rows.filter((row)=>info(row).role==="assistant"&&info(row).parentID===id);
  const assistantIds=(rows,id)=>assistantRows(rows,id).map((row)=>info(row).id);
  const assistantSummary=(rows,id)=>assistantRows(rows,id).map((row)=>({id:info(row).id,time:info(row).time??null,error:info(row).error??null,parts:(row.parts??[]).map((part)=>part.type)}));
  const promptBody=(messageID,text)=>({messageID,parts:[{type:"text",text}],model:{providerID:"openai",modelID:"anvil-scripted"}});
  let modelSequence=0;

  try{
    await startServer();
    const created=await api(`${base}/session`,"POST",{});
    if(![200,201].includes(created.status))throw new Error(`session create returned ${created.status}: ${JSON.stringify(created.body)}`);
    const sessionId=created.body?.id??created.body?.sessionID;
    if(!sessionId)throw new Error(`session response had no ID: ${JSON.stringify(created.body)}`);

    const busyId="msg_anvil_spike_busy_duplicate_01";
    const busyPrompt=promptBody(busyId,"ANVIL-E2E:wait-for-release busy duplicate probe");
    const busyFirst=await api(`${base}/session/${sessionId}/prompt_async`,"POST",busyPrompt);
    if(busyFirst.status!==204)throw new Error(`first prompt returned ${busyFirst.status}: ${JSON.stringify(busyFirst.body)}`);
    await waitFor(async()=>hasUser(await messageRows(sessionId),busyId),"busy user message persistence");
    await waitFor(()=>modelRequests.some((request)=>request.text.includes("busy duplicate probe")),"model acceptance of first busy prompt");
    const duplicateBusyPending=api(`${base}/session/${sessionId}/prompt_async`,"POST",busyPrompt,5000);
    await delay(300);
    const busyRequestsWhileHeld=modelRequests.filter((request)=>request.text.includes("busy duplicate probe")).length;
    await api(`http://127.0.0.1:${modelPort}/__test/release`,"POST",{});
    const duplicateBusy=await duplicateBusyPending;
    await waitFor(async()=>assistantIds(await messageRows(sessionId),busyId).length>0,"busy assistant completion");
    const busyAssistants=assistantIds(await messageRows(sessionId),busyId);
    const busyUserRecords=(await messageRows(sessionId)).filter((row)=>info(row).id===busyId&&info(row).role==="user").length;

    await api(`http://127.0.0.1:${modelPort}/__test/hold`,"POST",{});
    const modelCountBeforeIdle=modelRequests.filter((request)=>request.text.includes("busy duplicate probe")).length;
    const idleDuplicate=await api(`${base}/session/${sessionId}/prompt_async`,"POST",busyPrompt);
    await delay(300);
    const idleModelCallsWhileHeld=modelRequests.filter((request)=>request.text.includes("busy duplicate probe")).length-modelCountBeforeIdle;
    await api(`http://127.0.0.1:${modelPort}/__test/release`,"POST",{});
    await delay(1000);
    const idleAssistants=assistantIds(await messageRows(sessionId),busyId);

    const timeoutId="msg_anvil_spike_timeout_after_dispatch_02";
    await api(`http://127.0.0.1:${modelPort}/__test/hold`,"POST",{});
    await api(`http://127.0.0.1:${modelPort}/__test/hold`,"POST",{});
    const wirePayload=JSON.stringify(promptBody(timeoutId,"ANVIL-E2E:wait-for-release timeout-after-acceptance probe"));
    await new Promise((ok,fail)=>{
      const socket=createConnection({host:"127.0.0.1",port:openCodePort},()=>{
        socket.write(`POST /session/${sessionId}/prompt_async HTTP/1.1\r\nHost: 127.0.0.1:${openCodePort}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(wirePayload)}\r\nConnection: close\r\n\r\n${wirePayload}`);
        setTimeout(()=>{socket.destroy();ok();},250);
      });
      socket.once("error",fail);
    });
    await waitFor(async()=>hasUser(await messageRows(sessionId),timeoutId),"client-closed user message persistence");
    await waitFor(()=>modelRequests.some((request)=>request.text.includes("timeout-after-acceptance probe")),"model acceptance after client close");
    const timeoutAssistantsBeforeCrash=assistantIds(await messageRows(sessionId),timeoutId);
    const timeoutAssistantSummaryBeforeCrash=assistantSummary(await messageRows(sessionId),timeoutId);
    const gatedTimeoutRequests=modelRequests.filter((request)=>request.text.includes("timeout-after-acceptance probe")&&request.gated&&!request.completed).length;
    process.kill(-server.pid,"SIGKILL");
    await new Promise((ok)=>server.once("exit",ok));
    await startServer();
    const messagesAfterRestart=await messageRows(sessionId);
    const timeoutUserAfterRestart=hasUser(messagesAfterRestart,timeoutId);
    const timeoutAssistantsAfterRestart=assistantIds(messagesAfterRestart,timeoutId);
    await api(`http://127.0.0.1:${modelPort}/__test/release`,"POST",{});
    await delay(500);
    const messagesAfterLateRelease=await messageRows(sessionId);
    modelSequence=modelRequests.length;

    console.log(JSON.stringify({
      pinned_opencode_version:execFileSync("opencode",["--version"],{cwd:root,env,encoding:"utf8"}).trim(),
      busy_first_http_status:busyFirst.status,
      busy_duplicate_http_status:duplicateBusy.status,
      busy_model_calls_while_held:busyRequestsWhileHeld,
      busy_user_message_records_for_message_id:busyUserRecords,
      busy_assistant_turns_for_message_id:busyAssistants.length,
      idle_duplicate_http_status:idleDuplicate.status,
      idle_duplicate_model_calls_while_held:idleModelCallsWhileHeld,
      idle_user_message_records_for_message_id:(await messageRows(sessionId)).filter((row)=>info(row).id===busyId&&info(row).role==="user").length,
      extra_idle_duplicate_assistant_turns:idleAssistants.length-busyAssistants.length,
      total_loopback_model_requests:modelSequence,
      timeout_client_closed_after_dispatch:true,
      user_message_persisted_before_restart:timeoutUserAfterRestart,
      assistant_count_before_crash:timeoutAssistantsBeforeCrash.length,
      assistant_records_before_crash:timeoutAssistantSummaryBeforeCrash,
      model_requests_still_gated_at_crash:gatedTimeoutRequests,
      assistant_count_immediately_after_restart:timeoutAssistantsAfterRestart.length,
      assistant_count_after_releasing_late_model_response:assistantIds(messagesAfterLateRelease,timeoutId).length,
      tool_calls_requested:0,
      precise_create_user_message_before_ensureRunning_crash_window:"UNPROVEN: process was killed during a gated model request; no OpenCode internal failpoint was added",
    },null,2));
  } finally{
    if(server?.exitCode===null){try{process.kill(-server.pid,"SIGTERM");}catch{}await new Promise((ok)=>server.once("exit",ok));}
    for(const release of releaseWaiters.splice(0))release();
    await new Promise((ok)=>modelServer.close(ok));
    closeSync(serverLog);
    await rm(temporary,{recursive:true,force:true});
  }
}

main().catch((error)=>{console.error(error);process.exitCode=1;});

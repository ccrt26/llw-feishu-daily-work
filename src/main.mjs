import {execFile} from "node:child_process";
import {randomBytes,randomUUID} from "node:crypto";
import {lstat,mkdir,open,readFile,rename,rm,writeFile} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {loadConfig,validatePdfTools} from "./config.mjs";
import {StateStore} from "./state-store.mjs";
import {VaultWriter} from "./vault-writer.mjs";
import {RecordCatalog} from "./record-catalog.mjs";
import {DailyWorkService} from "./service.mjs";
import {startLarkListener} from "./lark-runtime.mjs";
import {createDailyWorkCapability} from "./capabilities/daily-work/capability.mjs";
import {buildCapabilityRegistry} from "./capabilities/index.mjs";
import {createInvoiceCapability} from "./capabilities/invoice/capability.mjs";
import {inspectInvoiceFile} from "./capabilities/invoice/file-inspector.mjs";
import {validateInvoiceDecision} from "./capabilities/invoice/decision-validator.mjs";
import {InvoiceArchiveWriter} from "./capabilities/invoice/archive-writer.mjs";
import {prepareInvoicePdf} from "./capabilities/invoice/pdf-preparer.mjs";
import {downloadLarkResource,scavengeInvoiceTempRoot} from "./adapters/lark-resource-downloader.mjs";
import {downloadWechatResource} from "./adapters/wechat-resource-downloader.mjs";
import {createLarkMessenger} from "./adapters/lark-reply.mjs";
import {createWechatApi} from "./adapters/wechat-api.mjs";
import {startWechatListener} from "./adapters/wechat-runtime.mjs";
import {createWechatMessenger} from "./adapters/wechat-reply.mjs";
import {createChannelMessenger} from "./adapters/channel-messenger.mjs";
import {Dispatcher} from "./core/dispatcher.mjs";
import {ModelMode} from "./core/model-mode.mjs";
import {safeLog} from "./core/redaction.mjs";
import {loadRoutingContract} from "./core/routing-contract.mjs";
import {validateIntentRouterSkill} from "./core/intent-router-client.mjs";
import {createRouterTextTask,createDailyWorkInterpretTask,createInvoiceVisualTask} from "./core/semantic-tasks.mjs";

const run=promisify(execFile);

async function runMain() {
process.umask(0o077);

const configFile=process.argv[2] || "/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json";
const config=await loadConfig(configFile);
const invoiceConfig=config.capabilities.invoice;
await validatePdfTools(invoiceConfig);
const contracts={};
if (config.capabilities["daily-work"].enabled) contracts["daily-work"]=await loadRoutingContract(config.capabilities["daily-work"].skillRoot,"daily-work");
if (invoiceConfig.enabled) contracts.invoice=await loadRoutingContract(invoiceConfig.skillRoot,"invoice");
const routerSkillRoot=join(config.vaultRoot,".agents","skills","feishu-intent-router");
await validateIntentRouterSkill(routerSkillRoot);
const state=await StateStore.open(config.stateFile);
const modelMode=new ModelMode(config.modelStateFile);
const binding={senderId:config.senderId,chatId:config.chatId};
const bindings={feishu:{userId:config.senderId,conversationId:config.chatId}};
const larkMessenger=createLarkMessenger({cliPath:config.cliPath,profile:config.profile,boundChatId:config.chatId});
const wechatResources=new Map();
let wechatApi=null;
let wechatMessenger=null;
const messenger=createChannelMessenger({
  feishu:larkMessenger,
  wechat:{send:message=>{
    if (!wechatMessenger) throw new Error("invalid_reply_target");
    return wechatMessenger.send(message);
  }}
});
const deepseekTextConfiguration={
  deepseekEnabled:config.deepseekEnabled,
  deepseekModel:config.deepseekModel,
  deepseekKeychainService:config.deepseekKeychainService,
  deepseekKeychainAccount:config.deepseekKeychainAccount
};

const dailyWriter=new VaultWriter(config.vaultRoot);
const catalog=new RecordCatalog(config.vaultRoot);
const dailyWorkInterpret=createDailyWorkInterpretTask({codexPath:config.codexPath,workspaceRoot:config.vaultRoot,skillRoot:config.capabilities["daily-work"].skillRoot,...deepseekTextConfiguration});
const dailyService=new DailyWorkService({
  state,catalog,writer:dailyWriter,decide:dailyWorkInterpret
});
const dailyCapability=createDailyWorkCapability({service:dailyService});

const invoiceArchiveWriter=new InvoiceArchiveWriter({vaultRoot:config.vaultRoot,state});
const invoiceVisual=createInvoiceVisualTask({codexPath:config.codexPath,workspaceRoot:config.vaultRoot,skillRoot:invoiceConfig.skillRoot,timeoutMs:invoiceConfig.aiTimeoutMs});
const downloadInvoiceResource=resource => {
  if (resource.source==="feishu") {
    return downloadLarkResource({
      cliPath:config.cliPath,profile:config.profile,tempRoot:invoiceConfig.tempRoot,
      timeoutMs:invoiceConfig.aiTimeoutMs,...resource
    });
  }
  if (resource.source==="wechat"&&wechatApi) {
    return downloadWechatResource({
      api:wechatApi,resources:wechatResources,tempRoot:invoiceConfig.tempRoot,
      maxFileBytes:invoiceConfig.maxFileBytes,timeoutMs:invoiceConfig.aiTimeoutMs,...resource
    });
  }
  throw Object.assign(new Error("download_failed"),{code:"download_failed"});
};
const invoiceCapability=createInvoiceCapability({
  download:downloadInvoiceResource,
  inspect:file => inspectInvoiceFile(file,{maxBytes:invoiceConfig.maxFileBytes}),
  preparePdf:({file}) => prepareInvoicePdf({
    file,
    pdfInfoPath:invoiceConfig.pdfInfoPath,
    pdfToTextPath:invoiceConfig.pdfToTextPath,
    pdfToPpmPath:invoiceConfig.pdfToPpmPath,
    maxPages:invoiceConfig.maxPdfPages,
    maxTextBytes:invoiceConfig.maxPdfTextBytes,
    maxRenderBytes:invoiceConfig.maxPdfRenderBytes,
    timeoutMs:invoiceConfig.pdfPrepareTimeoutMs
  }),
  decide:invoiceVisual,
  validate:validateInvoiceDecision,
  writer:invoiceArchiveWriter
});

const capabilities=buildCapabilityRegistry({dailyWork:dailyCapability,invoice:invoiceCapability,contracts,enabled:{"daily-work":config.capabilities["daily-work"].enabled,invoice:invoiceConfig.enabled}});
const routerText=createRouterTextTask({codexPath:config.codexPath,workspaceRoot:config.vaultRoot,skillRoot:routerSkillRoot,timeoutMs:invoiceConfig.aiTimeoutMs,...deepseekTextConfiguration});
const intentRouter={decide:routerText};
const dispatcher=new Dispatcher({binding,bindings,state,capabilities,intentRouter,messenger,modelMode,deepseekEnabled:config.deepseekEnabled});

await scavengeInvoiceTempRoot(invoiceConfig.tempRoot);
await invoiceArchiveWriter.recoverTransactions();
await dispatcher.resumeReplies();
await heartbeat(config.heartbeatFile);
const heartbeatTimer=setInterval(() => heartbeat(config.heartbeatFile).catch(() => {}),30_000);
const {larkListener,wechatListener}=await startChatEntries({
  wechatEnabled:config.wechatEnabled,
  startFeishu:startLarkListener,
  startWechat:async options=>{
    try {
      const channel=await openWechatChannel({config,resources:wechatResources});
      wechatApi=channel.api;
      wechatMessenger=createWechatMessenger({api:channel.api,boundUserId:channel.binding.userId});
      bindings.wechat=channel.binding;
      return await startWechatListener({...options,api:channel.api,state:channel.state,binding:channel.binding});
    } catch (error) {
      wechatApi=null;
      wechatMessenger=null;
      delete bindings.wechat;
      throw error;
    }
  },
  feishuOptions:{
    cliPath:config.cliPath,
    profile:config.profile,
    onEvent:event => dispatcher.handleRawEvent(event),
    onError:() => process.stderr.write(`${safeLog({stage:"listener",code:"event_handler_failed"})}\n`)
  },
  wechatOptions:{
    onMessage:message=>dispatcher.handleIncomingMessage(message),
    onError:error=>process.stderr.write(`${safeLog({stage:"listener",code:error?.code||"wechat_listener_error"})}\n`)
  },
  onWechatLog:code=>process.stderr.write(`${safeLog({stage:"listener",code})}\n`)
});

let stopping=false;
const shutdown=async () => {
  if (stopping) return;
  stopping=true; clearInterval(heartbeatTimer);
  try { await wechatListener?.stop?.(); } catch {}
  try { await larkListener.stop(); } finally { process.exit(0); }
};
process.on("SIGINT",shutdown); process.on("SIGTERM",shutdown);

try { await larkListener.done; if (!stopping) throw new Error("listener_exited"); }
finally { clearInterval(heartbeatTimer); }
}

export async function startChatEntries({
  wechatEnabled,
  startFeishu,
  startWechat,
  feishuOptions,
  wechatOptions,
  onWechatLog=()=>{}
}) {
  if (typeof wechatEnabled!=="boolean"||typeof startFeishu!=="function"||
      typeof startWechat!=="function"||typeof onWechatLog!=="function") {
    throw new Error("invalid_chat_entries");
  }
  const larkListener=await startFeishu(feishuOptions);
  let wechatListener=null;
  if (wechatEnabled) {
    try {
      wechatListener=await startWechat(wechatOptions);
    } catch {
      reportWechatEntry(onWechatLog,"wechat_start_failed");
      return {larkListener,wechatListener:null};
    }
    wechatListener?.done?.catch(()=>reportWechatEntry(onWechatLog,"wechat_listener_stopped"));
  }
  return {larkListener,wechatListener};
}

async function openWechatChannel({config,resources}) {
  const value=await readWechatChannelState(config.wechatStateFile);
  const token=await readWechatToken({
    service:config.wechatKeychainService,
    account:config.wechatKeychainAccount
  });
  const uIn=Buffer.from(String(randomBytes(4).readUInt32BE(0)),"utf8").toString("base64");
  const api=createWechatApi({baseUrl:value.apiBaseUrl,token,uIn});
  const binding={userId:value.ownerUserId,conversationId:value.ownerUserId};
  let cursor=value.syncCursor;
  const state={
    resources,
    readCursor:async()=>cursor,
    writeCursor:async nextCursor=>{
      const next={...value,syncCursor:nextCursor};
      validateWechatChannelState(next);
      await writeWechatChannelState(config.wechatStateFile,next);
      value.syncCursor=nextCursor;
      cursor=nextCursor;
    }
  };
  return {api,binding,state};
}

async function readWechatChannelState(file) {
  let handle;
  try {
    const pathInfo=await lstat(file);
    if (!pathInfo.isFile()||pathInfo.isSymbolicLink()||pathInfo.uid!==process.getuid()||(pathInfo.mode&0o077)!==0) {
      throw new Error("invalid");
    }
    handle=await open(file,"r");
    const fileInfo=await handle.stat();
    if (!fileInfo.isFile()||fileInfo.uid!==process.getuid()||(fileInfo.mode&0o077)!==0||
        fileInfo.dev!==pathInfo.dev||fileInfo.ino!==pathInfo.ino) {
      throw new Error("invalid");
    }
    const raw=await handle.readFile({encoding:"utf8"});
    const value=JSON.parse(raw);
    validateWechatChannelState(value);
    return value;
  } catch {
    throw new Error("wechat_state_unavailable");
  } finally {
    await handle?.close().catch(()=>{});
  }
}

async function writeWechatChannelState(file,value) {
  validateWechatChannelState(value);
  const parent=dirname(file);
  let temporary;
  try {
    const parentInfo=await lstat(parent);
    if (!parentInfo.isDirectory()||parentInfo.isSymbolicLink()||parentInfo.uid!==process.getuid()||(parentInfo.mode&0o077)!==0) {
      throw new Error("invalid");
    }
    const current=await lstat(file);
    if (!current.isFile()||current.isSymbolicLink()||current.uid!==process.getuid()||(current.mode&0o077)!==0) {
      throw new Error("invalid");
    }
    temporary=`${file}.${randomUUID()}.tmp`;
    const handle=await open(temporary,"wx",0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value,null,2)}\n`,"utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary,file);
    temporary=undefined;
  } catch {
    throw new Error("wechat_state_write_failed");
  } finally {
    if (temporary) await rm(temporary,{force:true}).catch(()=>{});
  }
}

async function readWechatToken({service,account}) {
  try {
    const {stdout}=await run("/usr/bin/security",[
      "find-generic-password","-w","-s",service,"-a",account
    ],{encoding:"utf8",maxBuffer:8192});
    const token=stdout.replace(/\r?\n$/,"");
    if (!token||Buffer.byteLength(token,"utf8")>4096||token.includes("\n")||token.includes("\r")) throw new Error("invalid");
    return token;
  } catch {
    throw new Error("wechat_key_unavailable");
  }
}

function validateWechatChannelState(value) {
  const fields=new Set(["version","apiBaseUrl","botId","ownerUserId","syncCursor"]);
  if (!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==fields.size||
      Object.keys(value).some(key=>!fields.has(key))||value.version!==1||
      !bounded(value.botId,512)||!bounded(value.ownerUserId,512)||
      typeof value.syncCursor!=="string"||Buffer.byteLength(value.syncCursor,"utf8")>1024*1024) {
    throw new Error("invalid_wechat_state");
  }
  createWechatApi({
    fetchImpl:async()=>{},
    baseUrl:value.apiBaseUrl,
    token:"validation-only",
    uIn:"MTIzNA=="
  });
}

function reportWechatEntry(logger,code) {
  try { logger(code); } catch {}
}

function bounded(value,maxBytes) {
  return typeof value==="string"&&value.length>0&&Buffer.byteLength(value,"utf8")<=maxBytes;
}

async function heartbeat(file) {
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const temporary=`${file}.tmp`;
  await writeFile(temporary,`${JSON.stringify({updatedAt:new Date().toISOString()})}\n`,{mode:0o600});
  await rename(temporary,file);
}

if (process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  await runMain();
}

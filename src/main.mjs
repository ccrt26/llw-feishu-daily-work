import {execFile} from "node:child_process";
import {randomBytes,randomUUID} from "node:crypto";
import {
  chmod,lstat,mkdir,open,realpath,rename,rm,writeFile
} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {loadConfig} from "./config.mjs";
import {StateStore} from "./state-store.mjs";
import {VaultWriter} from "./vault-writer.mjs";
import {RecordCatalog} from "./record-catalog.mjs";
import {startLarkListener} from "./lark-runtime.mjs";
import {KnowledgeWriter} from "./capabilities/knowledge-ingest/knowledge-writer.mjs";
import {
  createFeishuDocumentExporter
} from "./capabilities/knowledge-ingest/feishu-document-exporter.mjs";
import {
  invokeLocalArtifactGeneration
} from "./capabilities/assistant-work/artifact-generation-client.mjs";
import {
  InvoiceArchiveWriter
} from "./capabilities/invoice/archive-writer.mjs";
import {
  validatePdfiumRuntime
} from "./capabilities/invoice/pdfium-runtime.mjs";
import {
  downloadLarkResource,scavengeInvoiceTempRoot
} from "./adapters/lark-resource-downloader.mjs";
import {
  downloadWechatResource
} from "./adapters/wechat-resource-downloader.mjs";
import {createLarkMessenger} from "./adapters/lark-reply.mjs";
import {createWechatApi} from "./adapters/wechat-api.mjs";
import {startWechatListener} from "./adapters/wechat-runtime.mjs";
import {createWechatMessenger} from "./adapters/wechat-reply.mjs";
import {createChannelMessenger} from "./adapters/channel-messenger.mjs";
import {ModelMode} from "./core/model-mode.mjs";
import {effectiveModel} from "./core/model-command.mjs";
import {safeLog} from "./core/redaction.mjs";
import {
  loadPrivateSkillManifest
} from "./core/private-skill-manifest.mjs";
import {
  FileOutputWorkspace
} from "./workspace/file-output-workspace.mjs";
import {
  PersonalAssistantClient
} from "./personal-assistant/client.mjs";
import {
  invokePersonalAssistantCodex,invokePersonalAssistantDeepSeek
} from "./personal-assistant/invoke-personal-assistant.mjs";
import {
  loadPersonalAssistantSkillBundle
} from "./personal-assistant/skill-bundle.mjs";
import {
  createAssistantSourcePreparer
} from "./personal-assistant/source-preparer.mjs";
import {
  PersonalAssistantCoordinator
} from "./personal-assistant/coordinator.mjs";
import {
  PersonalAssistantDispatcher
} from "./personal-assistant/dispatcher.mjs";
import {
  PersonalRulesStore
} from "./personal-assistant/personal-rules.mjs";
import {
  PersonalAssistantTaskSessionManager
} from "./personal-assistant/task-session-manager.mjs";
import {
  TaskSourceWorkspace
} from "./personal-assistant/task-source-workspace.mjs";
import {
  TaskPdfReader
} from "./personal-assistant/task-pdf-reader.mjs";
import {
  createBilibiliPublicAdapter
} from "./personal-assistant/bilibili-public-adapter.mjs";
import {
  createDouyinPublicAdapter
} from "./personal-assistant/douyin-public-adapter.mjs";
import {
  createDouyinWebKitReaderAdapter
} from "./personal-assistant/douyin-webkit-reader-adapter.mjs";
import {
  ExternalVideoAsrUsageStore
} from "./personal-assistant/external-video-asr-usage-store.mjs";
import {
  inspectIsoBmffMediaHeader
} from "./personal-assistant/iso-bmff-media-header.mjs";
import {
  createPublicVideoSourcePreparer,
  createTurnSourcePreparerWithPublicVideo
} from "./personal-assistant/public-video-source-preparer.mjs";
import {
  TaskPublicVideoReader
} from "./personal-assistant/task-public-video-reader.mjs";
import {
  createVideoTimelineReaderAdapter
} from "./personal-assistant/video-timeline-reader-adapter.mjs";
import {
  createVolcengineVideoAsrAdapter
} from "./personal-assistant/volcengine-video-asr-adapter.mjs";

export const VIDEO_TIMELINE_HELPER_PATH=
  "/Users/ccrt/Library/Application Support/LLW Assistant/runtime/video-timeline-reader-v1/video_timeline_reader_v1";
export const VIDEO_TIMELINE_HELPER_SHA256=
  "b3b79f1770b49b75223d4a085ba41001256c985a3bde36d3317b9dd90a8f5a3f";
export const DOUYIN_WEBKIT_HELPER_PATH=
  "/Users/ccrt/Library/Application Support/LLW Assistant/runtime/douyin-webkit-reader-v1/douyin_webkit_reader_v1";
export const DOUYIN_WEBKIT_HELPER_SHA256=
  "91fc46449857ee7d1a5134ef0fd9700ae79855bd62375374eeea13af9ce86a37";

const run=promisify(execFile);

export const V6_PRIVATE_SKILL_ALLOWLIST=[{
  name:"llw-personal-assistant",
  capability:"personal-assistant",
  versions:["4.3.1"],
  semanticTasks:["personal-assistant.turn"],
  modelSupport:["codex","deepseek"],
  enabled:true
}];

async function runMain() {
  process.umask(0o077);
  const configFile=process.argv[2] ||
    "/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json";
  const config=await loadConfig(configFile);
  if (config.version===6) {
    throw new Error("config_migration_required");
  }
  if (config.version!==7) {
    const {runLegacyMain}=await import("./legacy-main.mjs");
    await runLegacyMain(configFile);
    return;
  }
  await runPersonalAssistantMain(config);
}

async function runPersonalAssistantMain(config) {
  const invoiceConfig=config.capabilities.invoice;
  const knowledgeConfig=config.capabilities["knowledge-ingest"];
  const documentConfig=config.capabilities["assistant-work"];
  const privateSkillCatalog=await loadPrivateSkillManifest({
    root:config.privateSkills.root,
    manifestPath:config.privateSkills.manifestPath,
    expectedManifestSha256:config.privateSkills.expectedManifestSha256,
    allowlist:V6_PRIVATE_SKILL_ALLOWLIST
  });
  const skillEntry=privateSkillCatalog.skills.find(
    entry=>entry.name===config.personalAssistant.skillName
  );
  if (!skillEntry) throw new Error("private_skill_manifest_invalid");
  const skillRoot=await selectPrivateSkillRoot(
    privateSkillCatalog,config.personalAssistant.skillName
  );
  const skillBundle=await loadPersonalAssistantSkillBundle({
    skillRoot,
    runtimeFiles:skillEntry.runtimeFiles
  });
  process.stderr.write(`${safeLog({
    stage:"startup",
    code:"personal_assistant_skill_loaded",
    fileCount:skillBundle.fileCount,
    totalBytes:skillBundle.totalBytes,
    bundleSha256:skillBundle.sha256
  })}\n`);
  await validatePdfiumRuntime(invoiceConfig.pdfProcessorPath);
  const personalRulesStore=config.personalAssistant.personalRulesFile
    ?await PersonalRulesStore.open(
      config.personalAssistant.personalRulesFile
    )
    :null;
  const feishuDocumentExporter=createFeishuDocumentExporter({
    cliPath:config.cliPath,profile:config.profile,
    tempRoot:knowledgeConfig.tempRoot,
    timeoutMs:config.personalAssistant.aiTimeoutMs
  });
  const state=await StateStore.open(config.stateFile,{
    migratePersonalAssistantConversations:true
  });
  const modelMode=new ModelMode(config.modelStateFile);
  const binding={senderId:config.senderId,chatId:config.chatId};
  const bindings={
    feishu:{userId:config.senderId,conversationId:config.chatId},
    wechat:null
  };
  const larkMessenger=createLarkMessenger({
    cliPath:config.cliPath,profile:config.profile,boundChatId:config.chatId
  });
  const wechatResources=new Map();
  let wechatApi=null,wechatMessenger=null;
  const messenger=createChannelMessenger({
    feishu:larkMessenger,
    wechat:{send:message=>{
      if (!wechatMessenger) throw new Error("invalid_reply_target");
      return wechatMessenger.send(message);
    }}
  });
  const download=({message,attachment})=>{
    if (message.source==="feishu") {
      return downloadLarkResource({
        cliPath:config.cliPath,profile:config.profile,
        messageId:message.sourceMessageId,
        fileKey:attachment.sourceAttachmentId,
        type:attachment.type==="image"?"image":"file",
        tempRoot:knowledgeConfig.tempRoot,
        timeoutMs:config.personalAssistant.aiTimeoutMs
      });
    }
    if (message.source==="wechat"&&wechatApi) {
      return downloadWechatResource({
        api:wechatApi,resourceId:attachment.sourceAttachmentId,
        resources:wechatResources,tempRoot:knowledgeConfig.tempRoot,
        maxFileBytes:invoiceConfig.maxFileBytes,
        timeoutMs:config.personalAssistant.aiTimeoutMs,
        allowedFileExtensions:[
          "pdf","txt","md","docx","pptx","xlsx"
        ]
      });
    }
    throw new Error("download_failed");
  };
  const basePrepareTurnSources=createAssistantSourcePreparer({
    download,
    exportFeishuDocument:feishuDocumentExporter.exportSnapshot,
    tempRoot:knowledgeConfig.tempRoot,
    cleanup:directory=>rm(directory,{recursive:true,force:true}),
    maxSourcesPerTurn:config.personalAssistant.maxSourcesPerTurn,
    maxFileBytes:config.personalAssistant.maxSourceFileBytes,
    maxTurnSourceBytes:config.personalAssistant.maxTurnSourceBytes
  });
  const publicVideoRuntime=await createPublicVideoProductionComposition({
    bilibiliEnabled:config.mediaInputGates.bilibiliEnabled,
    douyinEnabled:config.mediaInputGates.douyinEnabled,
    basePreparer:basePrepareTurnSources,
    stateRoot:dirname(config.stateFile)
  });
  const prepareTurnSources=publicVideoRuntime.prepareTurnSources;
  const assistant=new PersonalAssistantClient({
    codex:(context,{
      workspaceDir,imageFiles,modelImageFiles,allowSourceRead
    })=>invokePersonalAssistantCodex({
      codexPath:config.codexPath,workspaceDir,
      skillBundle,context,imageFiles,modelImageFiles,allowSourceRead,
      timeoutMs:config.personalAssistant.aiTimeoutMs
    }),
    deepseek:(context,{
      imageFiles,modelImageFiles
    })=>invokePersonalAssistantDeepSeek({
      model:config.deepseekModel,
      keychainService:config.deepseekKeychainService,
      keychainAccount:config.deepseekKeychainAccount,
      skillBundle,context,imageFiles,modelImageFiles
    })
  });
  const dailyCatalog=new RecordCatalog(config.vaultRoot);
  const invoiceWriter=new InvoiceArchiveWriter({
    vaultRoot:config.vaultRoot,state
  });
  const documentWorkspace=new FileOutputWorkspace({
    tempRoot:documentConfig.tempRoot,
    outputRoot:documentConfig.outputRoot,
    maxOutputBytes:documentConfig.maxOutputBytes,
    outputRetentionDays:documentConfig.outputRetentionDays
  });
  const outcomeStore={
    get:key=>state.getOutcome(key),
    save:(outcome,key)=>state.saveOutcome(key,{
      capability:"personal-assistant",
      ...outcome,
      createdAt:new Date().toISOString()
    }),
    markReplied:key=>state.markReplied(key)
  };
  const selectModel=createPersonalAssistantModelSelector({
    modelMode,deepseekEnabled:config.deepseekEnabled
  });
  const taskManager=new PersonalAssistantTaskSessionManager({
    state,bindings,selectModel
  });
  const taskWorkspace=new TaskSourceWorkspace({
    root:join(dirname(config.stateFile),"task-sources"),
    prepareTurnSources
  });
  const pdfReader=new TaskPdfReader({
    pdfProcessorPath:invoiceConfig.pdfProcessorPath,
    tempRoot:invoiceConfig.tempRoot,
    maxPages:invoiceConfig.maxPdfPages,
    maxTextBytes:invoiceConfig.maxPdfTextBytes,
    maxRenderBytes:invoiceConfig.maxPdfRenderBytes,
    maxDimension:3508,
    timeoutMs:invoiceConfig.pdfPrepareTimeoutMs
  });
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:prepareTurnSources,assistant,
    writer:new KnowledgeWriter({
      vaultRoot:config.vaultRoot,libraries:knowledgeConfig.libraries
    }),
    dailyWriter:new VaultWriter(config.vaultRoot),
    invoiceWriter,
    documentWorkspace,
    artifactGenerator:job=>invokeLocalArtifactGeneration({
      codexPath:config.codexPath,
      timeoutMs:documentConfig.aiTimeoutMs,...job
    }),
    outcomeStore,messenger,
    loadDailyCandidates:()=>dailyCatalog.list({limit:20}).catch(()=>[]),
    personalRules:[],
    personalRulesStore,
    taskManager,taskWorkspace,pdfReader,
    publicVideoReader:publicVideoRuntime.publicVideoReader,
    model:"codex",
    skillVersion:"4.3.1"
  });
  const dispatcher=new PersonalAssistantDispatcher({
    binding,bindings,state,coordinator,modelMode,
    taskManager,taskWorkspace,
    cancelTaskWork:value=>coordinator.cancelTaskWork(value),
    mediaInputGates:config.mediaInputGates,
    deepseekEnabled:config.deepseekEnabled,messenger,
    onFailure:createPersonalAssistantFailureLogger(),
    sourceBurstQuietMs:config.personalAssistant.sourceBurstQuietMs,
    sourceBurstMaxMs:config.personalAssistant.sourceBurstMaxMs,
    sourceBurstAttachmentQuietMs:config.personalAssistant.sourceBurstMaxMs,
    maxSourcesPerTurn:config.personalAssistant.maxSourcesPerTurn
  });
  await scavengeInvoiceTempRoot(invoiceConfig.tempRoot);
  await scavengeInvoiceTempRoot(knowledgeConfig.tempRoot);
  await invoiceWriter.recoverTransactions();
  await dispatcher.resumeReplies();
  const cleanupOutputs=()=>documentWorkspace.cleanup({
    protectedPaths:state.retainedReplyFilePaths({
      retentionDays:documentConfig.outputRetentionDays
    })
  });
  const cleanupTaskSources=async()=>{
    await taskManager.recoverPending();
    await taskWorkspace.cleanupExpired({
      activeTaskIds:["feishu","wechat"]
        .map(source=>taskManager.current(source)?.taskId)
        .filter(Boolean),
      now:new Date().toISOString()
    });
  };
  await cleanupOutputs();
  await cleanupTaskSources();
  await heartbeat(config.heartbeatFile);
  const heartbeatTimer=setInterval(()=>
    heartbeat(config.heartbeatFile).catch(()=>{}),30_000
  );
  const cleanupTimer=setInterval(()=>Promise.all([
    cleanupOutputs(),cleanupTaskSources()
  ]).catch(()=>{}),24*60*60*1000);
  cleanupTimer.unref();
  const {larkListener,wechatListener}=await startChatEntries({
    wechatEnabled:config.wechatEnabled,
    startFeishu:startLarkListener,
    startWechat:async options=>{
      const channel=await openWechatChannel({
        config,resources:wechatResources
      });
      wechatApi=channel.api;
      wechatMessenger=createWechatMessenger({
        api:channel.api,boundUserId:channel.binding.userId
      });
      bindings.wechat=channel.binding;
      taskManager.bind("wechat",channel.binding);
      return startWechatListener({
        ...options,api:channel.api,state:channel.state,
        binding:channel.binding
      });
    },
    feishuOptions:{
      cliPath:config.cliPath,profile:config.profile,
      onEvent:event=>dispatcher.acceptRawEvent(event),
      onError:()=>process.stderr.write(
        `${safeLog({stage:"listener",code:"event_handler_failed"})}\n`
      )
    },
    wechatOptions:{
      onMessage:message=>dispatcher.acceptIncomingMessage(message),
      onError:error=>process.stderr.write(
        `${safeLog({
          stage:"listener",code:error?.code||"wechat_listener_error"
        })}\n`
      )
    },
    onWechatLog:code=>process.stderr.write(
      `${safeLog({stage:"listener",code})}\n`
    )
  });
  await dispatcher.recoverPendingTasks();
  await cleanupTaskSources();
  let stopping=false;
  const shutdown=async()=>{
    if (stopping) return;
    stopping=true;
    clearInterval(heartbeatTimer);
    clearInterval(cleanupTimer);
    try { await wechatListener?.stop?.(); } catch {}
    try { await larkListener.stop(); }
    finally {
      await dispatcher.flushAcceptedMessages().catch(()=>{});
      process.exit(0);
    }
  };
  process.on("SIGINT",shutdown);
  process.on("SIGTERM",shutdown);
  try {
    await larkListener.done;
    if (!stopping) throw new Error("listener_exited");
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(cleanupTimer);
  }
}

export async function createPublicVideoProductionComposition({
  bilibiliEnabled,douyinEnabled,basePreparer,stateRoot
}={}) {
  if (typeof bilibiliEnabled!=="boolean"||
      typeof douyinEnabled!=="boolean"||
      typeof basePreparer!=="function"||
      typeof stateRoot!=="string"||!stateRoot.startsWith("/")) {
    throw new Error("public_video_production_configuration_invalid");
  }
  if (!bilibiliEnabled&&!douyinEnabled) {
    return Object.freeze({
      prepareTurnSources:basePreparer,
      publicVideoReader:null
    });
  }
  const timelineTempRoot=join(stateRoot,"video-timeline-jobs");
  await ensurePrivateRuntimeDirectory(timelineTempRoot);
  const usageStore=new ExternalVideoAsrUsageStore({
    file:join(stateRoot,"video-asr-usage.json")
  });
  const asr=createVolcengineVideoAsrAdapter({
    usageStore,
    keychainService:
      "com.llw.assistant.volcengine.video-asr.api-key",
    keychainAccount:"llw-assistant"
  });
  const timelineReader=createVideoTimelineReaderAdapter({
    helperPath:VIDEO_TIMELINE_HELPER_PATH,
    helperSha256:VIDEO_TIMELINE_HELPER_SHA256,
    tempRoot:timelineTempRoot,
    jobCwd:dirname(VIDEO_TIMELINE_HELPER_PATH)
  });
  const disabled=platform=>Object.freeze({
    async prepare() {
      throw new Error(`${platform}_disabled`);
    }
  });
  const bilibiliAdapter=bilibiliEnabled
    ?createBilibiliPublicAdapter({
      inspectMediaHeader:inspectIsoBmffMediaHeader
    })
    :disabled("bilibili");
  let douyinAdapter=disabled("douyin");
  if (douyinEnabled) {
    const douyinTempRoot=join(stateRoot,"douyin-webkit-jobs");
    await ensurePrivateRuntimeDirectory(douyinTempRoot);
    douyinAdapter=createDouyinPublicAdapter({
      reader:createDouyinWebKitReaderAdapter({
        helperPath:DOUYIN_WEBKIT_HELPER_PATH,
        helperSha256:DOUYIN_WEBKIT_HELPER_SHA256,
        tempRoot:douyinTempRoot,
        jobCwd:dirname(DOUYIN_WEBKIT_HELPER_PATH),
        timeoutMs:120_000
      })
    });
  }
  const publicVideoSourcePreparer=createPublicVideoSourcePreparer({
    tempRoot:join(stateRoot,"public-video-intake"),
    bilibiliAdapter,
    douyinAdapter
  });
  return Object.freeze({
    prepareTurnSources:createTurnSourcePreparerWithPublicVideo({
      basePreparer,
      publicVideoSourcePreparer
    }),
    publicVideoReader:new TaskPublicVideoReader({
      asr,timelineReader
    })
  });
}

async function ensurePrivateRuntimeDirectory(directory) {
  await mkdir(directory,{recursive:true,mode:0o700});
  await chmod(directory,0o700);
  const info=await lstat(directory);
  if (!info.isDirectory()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0) {
    throw new Error("public_video_production_configuration_invalid");
  }
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
    wechatListener?.done?.catch(()=>
      reportWechatEntry(onWechatLog,"wechat_listener_stopped")
    );
  }
  return {larkListener,wechatListener};
}

export async function selectPrivateSkillRoot(catalog,name,configuredRoot) {
  try {
    const entry=catalog.skills.find(skill=>skill.name===name);
    if (!entry) throw new Error("invalid");
    if (configuredRoot!==undefined&&(await realpath(configuredRoot))!==entry.root) {
      throw new Error("invalid");
    }
    return entry.root;
  } catch {
    throw new Error("private_skill_manifest_invalid");
  }
}

async function openWechatChannel({config,resources}) {
  const value=await readWechatChannelState(config.wechatStateFile);
  const token=await readWechatToken({
    service:config.wechatKeychainService,
    account:config.wechatKeychainAccount
  });
  const uIn=Buffer.from(
    String(randomBytes(4).readUInt32BE(0)),"utf8"
  ).toString("base64");
  const api=createWechatApi({baseUrl:value.apiBaseUrl,token,uIn});
  const binding={
    userId:value.ownerUserId,conversationId:value.ownerUserId
  };
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
    if (!pathInfo.isFile()||pathInfo.isSymbolicLink()||
        pathInfo.uid!==process.getuid()||(pathInfo.mode&0o077)!==0) {
      throw new Error("invalid");
    }
    handle=await open(file,"r");
    const fileInfo=await handle.stat();
    if (!fileInfo.isFile()||fileInfo.uid!==process.getuid()||
        (fileInfo.mode&0o077)!==0||
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
    if (!parentInfo.isDirectory()||parentInfo.isSymbolicLink()||
        parentInfo.uid!==process.getuid()||(parentInfo.mode&0o077)!==0) {
      throw new Error("invalid");
    }
    const current=await lstat(file);
    if (!current.isFile()||current.isSymbolicLink()||
        current.uid!==process.getuid()||(current.mode&0o077)!==0) {
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
    if (!token||Buffer.byteLength(token,"utf8")>4096||
        token.includes("\n")||token.includes("\r")) {
      throw new Error("invalid");
    }
    return token;
  } catch {
    throw new Error("wechat_key_unavailable");
  }
}

function validateWechatChannelState(value) {
  const fields=new Set([
    "version","apiBaseUrl","botId","ownerUserId","syncCursor"
  ]);
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length!==fields.size||
      Object.keys(value).some(key=>!fields.has(key))||value.version!==1||
      !bounded(value.botId,512)||!bounded(value.ownerUserId,512)||
      typeof value.syncCursor!=="string"||
      Buffer.byteLength(value.syncCursor,"utf8")>1024*1024) {
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

export function createPersonalAssistantFailureLogger(
  write=value=>process.stderr.write(value)
) {
  if (typeof write!=="function") {
    throw new Error("personal_assistant_failure_logger_invalid");
  }
  return code=>write(`${safeLog({stage:"analyze",code})}\n`);
}

export function createPersonalAssistantModelSelector({
  modelMode,deepseekEnabled
}) {
  if (typeof modelMode?.read!=="function"||
      typeof deepseekEnabled!=="boolean") {
    throw new Error("personal_assistant_model_selector_invalid");
  }
  return async()=>effectiveModel(
    await modelMode.read(),deepseekEnabled
  );
}

function bounded(value,maxBytes) {
  return typeof value==="string"&&value.length>0&&
    Buffer.byteLength(value,"utf8")<=maxBytes;
}

async function heartbeat(file) {
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const temporary=`${file}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({updatedAt:new Date().toISOString()})}\n`,
    {mode:0o600}
  );
  await rename(temporary,file);
}

if (process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  await runMain();
}

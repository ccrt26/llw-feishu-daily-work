import {execFile} from "node:child_process";
import {randomBytes,randomUUID} from "node:crypto";
import {lstat,mkdir,open,readFile,realpath,rename,rm,writeFile} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {loadConfig} from "./config.mjs";
import {StateStore} from "./state-store.mjs";
import {VaultWriter} from "./vault-writer.mjs";
import {RecordCatalog} from "./record-catalog.mjs";
import {DailyWorkService} from "./service.mjs";
import {startLarkListener} from "./lark-runtime.mjs";
import {createDailyWorkCapability} from "./capabilities/daily-work/capability.mjs";
import {buildCapabilityRegistry} from "./capabilities/index.mjs";
import {createInvoiceCapability} from "./capabilities/invoice/capability.mjs";
import {createKnowledgeIngestCapability} from "./capabilities/knowledge-ingest/capability.mjs";
import {createKnowledgeLibraryCatalog} from "./capabilities/knowledge-ingest/library-catalog.mjs";
import {KnowledgeWriter} from "./capabilities/knowledge-ingest/knowledge-writer.mjs";
import {prepareKnowledgeFile,prepareKnowledgeText} from "./capabilities/knowledge-ingest/source-preparer.mjs";
import {prepareKnowledgeOfficeFile} from "./capabilities/knowledge-ingest/office-source-preparer.mjs";
import {createFeishuDocumentExporter} from "./capabilities/knowledge-ingest/feishu-document-exporter.mjs";
import {createAssistantWorkCapability} from "./capabilities/assistant-work/capability.mjs";
import {invokeLocalArtifactGeneration} from "./capabilities/assistant-work/artifact-generation-client.mjs";
import {
  loadKnowledgeSources,searchKnowledge
} from "./capabilities/assistant-work/knowledge-search.mjs";
import {inspectInvoiceFile} from "./capabilities/invoice/file-inspector.mjs";
import {parseInvoiceResource} from "./capabilities/invoice/resource-marker.mjs";
import {validateInvoiceExtraction,deriveInvoiceRuleDecision} from "./capabilities/invoice/decision-validator.mjs";
import {InvoiceArchiveWriter} from "./capabilities/invoice/archive-writer.mjs";
import {prepareInvoicePdf} from "./capabilities/invoice/pdf-preparer.mjs";
import {validatePdfiumRuntime} from "./capabilities/invoice/pdfium-runtime.mjs";
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
import {createPreparedVisualRunner} from "./core/prepared-visual.mjs";
import {loadPrivateSkillManifest} from "./core/private-skill-manifest.mjs";
import {loadRoutingContract} from "./core/routing-contract.mjs";
import {validateIntentRouterSkill} from "./core/intent-router-client.mjs";
import {TaskSessionManager} from "./core/task-session-manager.mjs";
import {TaskWorkspace} from "./workspace/task-workspace.mjs";
import {FileOutputWorkspace} from "./workspace/file-output-workspace.mjs";
import {
  createRouterTextTask,createRouterVisualTask,createDailyWorkInterpretTask,
  createInvoiceVisualTask,createKnowledgeIngestTask,createAssistantWorkTask
} from "./core/semantic-tasks.mjs";
import {PersonalAssistantClient} from "./personal-assistant/client.mjs";
import {
  invokePersonalAssistantCodex,invokePersonalAssistantDeepSeek
} from "./personal-assistant/invoke-personal-assistant.mjs";
import {
  createAssistantSourcePreparer
} from "./personal-assistant/source-preparer.mjs";
import {
  PersonalAssistantCoordinator
} from "./personal-assistant/coordinator.mjs";
import {
  PersonalAssistantDispatcher
} from "./personal-assistant/dispatcher.mjs";
import {PersonalRulesStore} from "./personal-assistant/personal-rules.mjs";

const run=promisify(execFile);
export const PRIVATE_SKILL_ALLOWLIST=[
  {
    name:"feishu-intent-router",capability:"router",versions:["1.2.0"],
    semanticTasks:["router.text","router.visual"],modelSupport:["codex","deepseek"],enabled:true
  },
  {
    name:"feishu-daily-work",capability:"daily-work",versions:["1.0.0"],
    semanticTasks:["daily-work.interpret"],modelSupport:["codex","deepseek"],enabled:true
  },
  {
    name:"filing-invoices",capability:"invoice",versions:["1.0.0"],
    semanticTasks:["invoice.visual"],modelSupport:["codex"],enabled:true
  },
  {
    name:"llw-knowledge-ingest",capability:"knowledge-ingest",versions:["1.3.0"],
    semanticTasks:["knowledge.ingest"],modelSupport:["codex"],enabled:true
  },
  {
    name:"llw-assistant-work",capability:"assistant-work",versions:["1.1.0"],
    semanticTasks:["assistant.work"],modelSupport:["codex"],enabled:true
  }
];
export const V6_PRIVATE_SKILL_ALLOWLIST=[{
  name:"llw-personal-assistant",
  capability:"personal-assistant",
  versions:["4.0.1"],
  semanticTasks:["personal-assistant.turn"],
  modelSupport:["codex","deepseek"],
  enabled:true
}];

async function runMain() {
process.umask(0o077);

const configFile=process.argv[2] || "/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json";
const config=await loadConfig(configFile);
if (config.version===6) {
  await runPersonalAssistantMain(config);
  return;
}
const invoiceConfig=config.capabilities.invoice;
const knowledgeConfig=config.version===5?config.capabilities["knowledge-ingest"]:null;
const assistantConfig=config.version===5?config.capabilities["assistant-work"]:null;
const knowledgePolicy=PRIVATE_SKILL_ALLOWLIST.find(
  item=>item.name==="llw-knowledge-ingest"
);
const knowledgeEnabled=knowledgeCandidateEnabled({
  allowlistEnabled:knowledgePolicy.enabled,
  configurationEnabled:knowledgeConfig?.enabled
});
const assistantPolicy=PRIVATE_SKILL_ALLOWLIST.find(
  item=>item.name==="llw-assistant-work"
);
const assistantEnabled=assistantCandidateEnabled({
  allowlistEnabled:assistantPolicy.enabled,
  configurationEnabled:assistantConfig?.enabled
});
const privateSkillCatalog=await loadPrivateSkillManifest({
  root:config.privateSkills?.root,
  manifestPath:config.privateSkills?.manifestPath,
  expectedManifestSha256:config.privateSkills?.expectedManifestSha256,
  allowlist:PRIVATE_SKILL_ALLOWLIST
});
const routerSkillRoot=await selectPrivateSkillRoot(privateSkillCatalog,"feishu-intent-router");
const dailySkillRoot=await selectPrivateSkillRoot(
  privateSkillCatalog,"feishu-daily-work",config.capabilities["daily-work"].skillRoot
);
const invoiceSkillRoot=await selectPrivateSkillRoot(
  privateSkillCatalog,"filing-invoices",invoiceConfig.skillRoot
);
let knowledgeSkillRoot=null;
if (knowledgeEnabled) {
  knowledgeSkillRoot=await selectPrivateSkillRoot(
    privateSkillCatalog,"llw-knowledge-ingest"
  );
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
  const skillRoot=await selectPrivateSkillRoot(
    privateSkillCatalog,config.personalAssistant.skillName
  );
  await validatePdfiumRuntime(invoiceConfig.pdfProcessorPath);
  const personalRulesStore=config.personalAssistant.personalRulesFile
    ?await PersonalRulesStore.open(
      config.personalAssistant.personalRulesFile
    )
    :null;
  const state=await StateStore.open(config.stateFile);
  const modelMode=new ModelMode(config.modelStateFile);
  const binding={senderId:config.senderId,chatId:config.chatId};
  const bindings={
    feishu:{userId:config.senderId,conversationId:config.chatId}
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
  const preparePdf=({file})=>prepareInvoicePdf({
    file,pdfProcessorPath:invoiceConfig.pdfProcessorPath,
    maxPages:invoiceConfig.maxPdfPages,
    maxTextBytes:invoiceConfig.maxPdfTextBytes,
    maxRenderBytes:invoiceConfig.maxPdfRenderBytes,
    timeoutMs:invoiceConfig.pdfPrepareTimeoutMs
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
  const prepareSource=createAssistantSourcePreparer({
    download,
    inspect:file=>inspectInvoiceFile(file,{
      maxBytes:invoiceConfig.maxFileBytes
    }),
    preparePdf,
    prepareOffice:input=>prepareKnowledgeOfficeFile({
      ...input,
      processorPath:new URL(
        "./capabilities/knowledge-ingest/ooxml_processor.py",import.meta.url
      ),
      timeoutMs:30_000
    }),
    prepareTextFile:prepareKnowledgeFile,
    cleanup:directory=>rm(directory,{recursive:true,force:true}),
    maxSourceBytes:knowledgeConfig.maxSourceBytes,
    maxFileBytes:invoiceConfig.maxFileBytes
  });
  const assistant=new PersonalAssistantClient({
    codex:(context,{imageFiles})=>invokePersonalAssistantCodex({
      codexPath:config.codexPath,workspaceRoot:config.vaultRoot,
      skillRoot,context,imageFiles,
      timeoutMs:config.personalAssistant.aiTimeoutMs
    }),
    deepseek:(context,{imageFiles})=>invokePersonalAssistantDeepSeek({
      model:config.deepseekModel,
      keychainService:config.deepseekKeychainService,
      keychainAccount:config.deepseekKeychainAccount,
      skillRoot,context,imageFiles
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
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource,assistant,
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
    conversationStore:{
      get:(source,now)=>state.getPersonalAssistantConversation(source,now),
      set:(source,value)=>state.setPersonalAssistantConversation(source,value),
      clear:source=>state.clearPersonalAssistantConversation(source)
    },
    loadDailyCandidates:()=>dailyCatalog.list({limit:20}).catch(()=>[]),
    personalRules:[],
    personalRulesStore,
    selectModel:async()=>effectiveModel(
      await modelMode.read(),config.deepseekEnabled
    ),
    model:"codex",
    skillVersion:"4.0.1"
  });
  const dispatcher=new PersonalAssistantDispatcher({
    binding,bindings,state,coordinator,modelMode,
    deepseekEnabled:config.deepseekEnabled,messenger
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
  await cleanupOutputs();
  await heartbeat(config.heartbeatFile);
  const heartbeatTimer=setInterval(()=>
    heartbeat(config.heartbeatFile).catch(()=>{}),30_000
  );
  const cleanupTimer=setInterval(()=>
    cleanupOutputs().catch(()=>{}),24*60*60*1000
  );
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
      return startWechatListener({
        ...options,api:channel.api,state:channel.state,
        binding:channel.binding
      });
    },
    feishuOptions:{
      cliPath:config.cliPath,profile:config.profile,
      onEvent:event=>dispatcher.handleRawEvent(event),
      onError:()=>process.stderr.write(
        `${safeLog({stage:"listener",code:"event_handler_failed"})}\n`
      )
    },
    wechatOptions:{
      onMessage:message=>dispatcher.handleIncomingMessage(message),
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
  let stopping=false;
  const shutdown=async()=>{
    if (stopping) return;
    stopping=true;
    clearInterval(heartbeatTimer);
    clearInterval(cleanupTimer);
    try { await wechatListener?.stop?.(); } catch {}
    try { await larkListener.stop(); }
    finally { process.exit(0); }
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
let assistantSkillRoot=null;
if (assistantEnabled) {
  assistantSkillRoot=await selectPrivateSkillRoot(
    privateSkillCatalog,"llw-assistant-work"
  );
}
await validatePdfiumRuntime(invoiceConfig.pdfProcessorPath);
const contracts={};
if (config.capabilities["daily-work"].enabled) contracts["daily-work"]=await loadRoutingContract(dailySkillRoot,"daily-work");
if (invoiceConfig.enabled) contracts.invoice=await loadRoutingContract(invoiceSkillRoot,"invoice");
if (knowledgeEnabled) {
  contracts["knowledge-ingest"]=await loadRoutingContract(
    knowledgeSkillRoot,"knowledge-ingest"
  );
}
if (assistantEnabled) {
  contracts["assistant-work"]=await loadRoutingContract(
    assistantSkillRoot,"assistant-work"
  );
}
await validateIntentRouterSkill(routerSkillRoot);
const state=await StateStore.open(config.stateFile,{
  taskSessionPolicy:[{capability:"assistant-work",models:["codex"]}]
});
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
const dailyCatalog=new RecordCatalog(config.vaultRoot);
const dailyWorkInterpret=createDailyWorkInterpretTask({codexPath:config.codexPath,workspaceRoot:config.vaultRoot,skillRoot:dailySkillRoot,...deepseekTextConfiguration});
const dailyService=new DailyWorkService({
  state,catalog:dailyCatalog,writer:dailyWriter,decide:dailyWorkInterpret
});
const dailyCapability=createDailyWorkCapability({service:dailyService});

const invoiceArchiveWriter=new InvoiceArchiveWriter({vaultRoot:config.vaultRoot,state});
const invoiceVisual=createInvoiceVisualTask({codexPath:config.codexPath,workspaceRoot:config.vaultRoot,skillRoot:invoiceSkillRoot,timeoutMs:invoiceConfig.aiTimeoutMs});
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
const inspectInvoiceResource=file => inspectInvoiceFile(file,{maxBytes:invoiceConfig.maxFileBytes});
const preparePdf=({file}) => prepareInvoicePdf({
  file,
  pdfProcessorPath:invoiceConfig.pdfProcessorPath,
  maxPages:invoiceConfig.maxPdfPages,
  maxTextBytes:invoiceConfig.maxPdfTextBytes,
  maxRenderBytes:invoiceConfig.maxPdfRenderBytes,
  timeoutMs:invoiceConfig.pdfPrepareTimeoutMs
});
const withPreparedVisual=createPreparedVisualRunner({
  parse:parseInvoiceResource,
  download:downloadInvoiceResource,
  inspect:inspectInvoiceResource,
  preparePdf
});
const invoiceCapability=createInvoiceCapability({
  download:downloadInvoiceResource,
  inspect:inspectInvoiceResource,
  preparePdf,
  decide:invoiceVisual,
  validate:validateInvoiceExtraction,
  derive:deriveInvoiceRuleDecision,
  writer:invoiceArchiveWriter
});

let knowledgeCapability=null;
if (knowledgeEnabled) {
  const knowledgeDecision=createKnowledgeIngestTask({
    codexPath:config.codexPath,
    skillRoot:knowledgeSkillRoot,
    tempRoot:knowledgeConfig.tempRoot,
    timeoutMs:knowledgeConfig.aiTimeoutMs
  });
  const knowledgeWriter=new KnowledgeWriter({
    vaultRoot:config.vaultRoot,
    libraries:knowledgeConfig.libraries
  });
  const feishuDocumentExporter=createFeishuDocumentExporter({
    cliPath:config.cliPath,
    profile:config.profile,
    tempRoot:knowledgeConfig.tempRoot,
    timeoutMs:knowledgeConfig.aiTimeoutMs
  });
  const downloadKnowledgeResource=({
    source,sourceMessageId,attachment
  })=>{
    if (source==="feishu") {
      return downloadLarkResource({
        cliPath:config.cliPath,
        profile:config.profile,
        messageId:sourceMessageId,
        fileKey:attachment.sourceAttachmentId,
        type:"file",
        tempRoot:knowledgeConfig.tempRoot,
        timeoutMs:knowledgeConfig.aiTimeoutMs
      });
    }
    if (source==="wechat"&&wechatApi) {
      return downloadWechatResource({
        api:wechatApi,
        resourceId:attachment.sourceAttachmentId,
        resources:wechatResources,
        tempRoot:knowledgeConfig.tempRoot,
        maxFileBytes:20*1024*1024,
        timeoutMs:knowledgeConfig.aiTimeoutMs,
        allowedFileExtensions:["txt","md","docx","pptx","xlsx"]
      });
    }
    throw Object.assign(new Error("download_failed"),{code:"download_failed"});
  };
  knowledgeCapability=createKnowledgeIngestCapability({
    decide:knowledgeDecision,
    writer:knowledgeWriter,
    catalog:()=>createKnowledgeLibraryCatalog(knowledgeConfig.libraries),
    sourcePreparer:({text})=>prepareKnowledgeText({
      text,maxSourceBytes:knowledgeConfig.maxSourceBytes
    }),
    filePreparer:input=>new Set(["docx","pptx","xlsx"]).has(input.extension)
      ?prepareKnowledgeOfficeFile({
        ...input,
        maxSourceBytes:20*1024*1024,
        maxExtractedBytes:knowledgeConfig.maxSourceBytes,
        processorPath:new URL(
          "./capabilities/knowledge-ingest/ooxml_processor.py",import.meta.url
        ),
        timeoutMs:30_000
      })
      :prepareKnowledgeFile({
        ...input,maxSourceBytes:knowledgeConfig.maxSourceBytes
      }),
    download:downloadKnowledgeResource,
    documentExporter:feishuDocumentExporter.exportSnapshot,
    onFailureStage:({code,stderrBytes,retryCount})=>{
      process.stderr.write(
        `${safeLog({stage:"analyze",code,stderrBytes,retryCount})}\n`
      );
    },
    skillVersion:privateSkillCatalog.skills.find(
      item=>item.name==="llw-knowledge-ingest"
    ).version
  });
}

let assistantCapability=null;
let taskSessionManager=null;
let fileOutputWorkspace=null;
if (assistantEnabled) {
  const assistantDecision=createAssistantWorkTask({
    codexPath:config.codexPath,
    skillRoot:assistantSkillRoot,
    tempRoot:assistantConfig.tempRoot,
    timeoutMs:assistantConfig.aiTimeoutMs
  });
  const taskWorkspace=new TaskWorkspace(assistantConfig.workspaceRoot);
  fileOutputWorkspace=new FileOutputWorkspace({
    tempRoot:assistantConfig.tempRoot,
    outputRoot:assistantConfig.outputRoot,
    maxOutputBytes:assistantConfig.maxOutputBytes,
    outputRetentionDays:assistantConfig.outputRetentionDays
  });
  taskSessionManager=new TaskSessionManager({
    state,workspace:taskWorkspace
  });
  await taskSessionManager.recover();
  const searchLibraries=knowledgeConfig.libraries.map(library=>({
    libraryKey:library.libraryKey,root:library.root
  }));
  const assistantSearch=({query,sourcePaths})=>sourcePaths.length
    ?loadKnowledgeSources({
      vaultRoot:config.vaultRoot,libraries:searchLibraries,sourcePaths,
      maxFileBytes:assistantConfig.maxSearchFileBytes,
      maxTotalExcerptBytes:assistantConfig.maxSourceExcerptBytes
    })
    :searchKnowledge({
      vaultRoot:config.vaultRoot,libraries:searchLibraries,query,
      maxFiles:assistantConfig.maxSearchFiles,
      maxFileBytes:assistantConfig.maxSearchFileBytes,
      maxResults:assistantConfig.maxSearchResults,
      maxTotalExcerptBytes:assistantConfig.maxSourceExcerptBytes
    });
  assistantCapability=createAssistantWorkCapability({
    decide:assistantDecision,
    search:assistantSearch,
    workspace:taskWorkspace,
    sessionManager:taskSessionManager,
    allowedOutputFormats:assistantConfig.allowedOutputFormats,
    generateFile:input=>fileOutputWorkspace.generate({
      ...input,
      generate:job=>invokeLocalArtifactGeneration({
        codexPath:config.codexPath,
        timeoutMs:assistantConfig.aiTimeoutMs,
        ...job
      })
    })
  });
}

const capabilities=buildCapabilityRegistry({
  dailyWork:dailyCapability,
  invoice:invoiceCapability,
  knowledgeIngest:knowledgeCapability,
  assistantWork:assistantCapability,
  contracts,
  enabled:{
    "daily-work":config.capabilities["daily-work"].enabled,
    invoice:invoiceConfig.enabled,
    "knowledge-ingest":knowledgeEnabled,
    "assistant-work":assistantEnabled
  }
});
const routerText=createRouterTextTask({codexPath:config.codexPath,workspaceRoot:config.vaultRoot,skillRoot:routerSkillRoot,timeoutMs:invoiceConfig.aiTimeoutMs,...deepseekTextConfiguration});
const routerVisual=createRouterVisualTask({codexPath:config.codexPath,workspaceRoot:config.vaultRoot,skillRoot:routerSkillRoot,timeoutMs:invoiceConfig.aiTimeoutMs});
const intentRouter={decide:routerText,decideVisual:routerVisual};
const dispatcher=new Dispatcher({
  binding,bindings,state,capabilities,intentRouter,withPreparedVisual,messenger,
  modelMode,deepseekEnabled:config.deepseekEnabled,taskSessionManager
});

await scavengeInvoiceTempRoot(invoiceConfig.tempRoot);
await invoiceArchiveWriter.recoverTransactions();
await dispatcher.resumeReplies();
const cleanupFileOutputs=async()=>{
  if (!fileOutputWorkspace) return;
  const nowMs=Date.now();
  await fileOutputWorkspace.cleanup({
    protectedPaths:state.retainedReplyFilePaths({
      nowMs,
      retentionDays:assistantConfig.outputRetentionDays
    }),
    nowMs
  });
};
await cleanupFileOutputs();
await heartbeat(config.heartbeatFile);
const heartbeatTimer=setInterval(() => heartbeat(config.heartbeatFile).catch(() => {}),30_000);
const fileOutputCleanupTimer=fileOutputWorkspace
  ?setInterval(()=>cleanupFileOutputs().catch(()=>{}),24*60*60*1000)
  :null;
fileOutputCleanupTimer?.unref();
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
  if (fileOutputCleanupTimer) clearInterval(fileOutputCleanupTimer);
  try { await wechatListener?.stop?.(); } catch {}
  try { await larkListener.stop(); } finally { process.exit(0); }
};
process.on("SIGINT",shutdown); process.on("SIGTERM",shutdown);

try { await larkListener.done; if (!stopping) throw new Error("listener_exited"); }
finally {
  clearInterval(heartbeatTimer);
  if (fileOutputCleanupTimer) clearInterval(fileOutputCleanupTimer);
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
    wechatListener?.done?.catch(()=>reportWechatEntry(onWechatLog,"wechat_listener_stopped"));
  }
  return {larkListener,wechatListener};
}

export function knowledgeCandidateEnabled({
  allowlistEnabled,configurationEnabled
}) {
  return allowlistEnabled===true&&configurationEnabled===true;
}

export function assistantCandidateEnabled({
  allowlistEnabled,configurationEnabled
}) {
  return allowlistEnabled===true&&configurationEnabled===true;
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

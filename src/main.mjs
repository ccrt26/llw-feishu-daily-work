import {mkdir,rename,writeFile} from "node:fs/promises";
import {dirname,join} from "node:path";
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
import {createLarkMessenger} from "./adapters/lark-reply.mjs";
import {Dispatcher} from "./core/dispatcher.mjs";
import {ModelMode} from "./core/model-mode.mjs";
import {safeLog} from "./core/redaction.mjs";
import {loadRoutingContract} from "./core/routing-contract.mjs";
import {validateIntentRouterSkill} from "./core/intent-router-client.mjs";
import {createRouterTextTask,createDailyWorkInterpretTask,createInvoiceVisualTask} from "./core/semantic-tasks.mjs";

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
const messenger=createLarkMessenger({cliPath:config.cliPath,profile:config.profile,boundChatId:config.chatId});

const dailyWriter=new VaultWriter(config.vaultRoot);
const catalog=new RecordCatalog(config.vaultRoot);
const dailyWorkInterpret=createDailyWorkInterpretTask({codexPath:config.codexPath,workspaceRoot:config.vaultRoot,skillRoot:config.capabilities["daily-work"].skillRoot});
const dailyService=new DailyWorkService({
  state,catalog,writer:dailyWriter,decide:dailyWorkInterpret
});
const dailyCapability=createDailyWorkCapability({service:dailyService});

const invoiceArchiveWriter=new InvoiceArchiveWriter({vaultRoot:config.vaultRoot,state});
const invoiceVisual=createInvoiceVisualTask({codexPath:config.codexPath,workspaceRoot:config.vaultRoot,skillRoot:invoiceConfig.skillRoot,timeoutMs:invoiceConfig.aiTimeoutMs});
const invoiceCapability=createInvoiceCapability({
  download:resource => downloadLarkResource({cliPath:config.cliPath,profile:config.profile,tempRoot:invoiceConfig.tempRoot,timeoutMs:invoiceConfig.aiTimeoutMs,...resource}),
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
const routerText=createRouterTextTask({codexPath:config.codexPath,workspaceRoot:config.vaultRoot,skillRoot:routerSkillRoot,timeoutMs:invoiceConfig.aiTimeoutMs});
const intentRouter={decide:routerText};
const dispatcher=new Dispatcher({binding,state,capabilities,intentRouter,messenger,modelMode,deepseekEnabled:config.deepseekEnabled});

await scavengeInvoiceTempRoot(invoiceConfig.tempRoot);
await invoiceArchiveWriter.recoverTransactions();
await dispatcher.resumeReplies();
await heartbeat(config.heartbeatFile);
const heartbeatTimer=setInterval(() => heartbeat(config.heartbeatFile).catch(() => {}),30_000);
const listener=await startLarkListener({
  cliPath:config.cliPath,
  profile:config.profile,
  onEvent:event => dispatcher.handleRawEvent(event),
  onError:() => process.stderr.write(`${safeLog({stage:"listener",code:"event_handler_failed"})}\n`)
});

let stopping=false;
const shutdown=async () => {
  if (stopping) return;
  stopping=true; clearInterval(heartbeatTimer);
  try { await listener.stop(); } finally { process.exit(0); }
};
process.on("SIGINT",shutdown); process.on("SIGTERM",shutdown);

try { await listener.done; if (!stopping) throw new Error("listener_exited"); }
finally { clearInterval(heartbeatTimer); }

async function heartbeat(file) {
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const temporary=`${file}.tmp`;
  await writeFile(temporary,`${JSON.stringify({updatedAt:new Date().toISOString()})}\n`,{mode:0o600});
  await rename(temporary,file);
}

import {randomUUID} from "node:crypto";
import {lstat,mkdir,open,readFile,rename} from "node:fs/promises";
import {dirname,isAbsolute,join,parse,resolve} from "node:path";

const V4_TOP_FIELDS=new Set([
  "version","vaultRoot","stateFile","heartbeatFile","modelStateFile",
  "deepseekEnabled","deepseekModel","deepseekKeychainService","deepseekKeychainAccount",
  "wechatEnabled","wechatStateFile","wechatKeychainService","wechatKeychainAccount",
  "cliPath","codexPath","profile","senderId","chatId","capabilities"
]);
const V5_TOP_FIELDS=new Set([...V4_TOP_FIELDS,"privateSkills"]);
const V6_TOP_FIELDS=new Set([...V5_TOP_FIELDS,"personalAssistant"]);
const V7_TOP_FIELDS=new Set([...V6_TOP_FIELDS,"mediaInputGates"]);
const PRIVATE_SKILLS_FIELDS=new Set(["root","manifestPath","expectedManifestSha256"]);
const PERSONAL_ASSISTANT_FIELDS=new Set([
  "enabled","skillName","aiTimeoutMs","maxContextBytes",
  "maxSourcesPerTurn","maxSourceFileBytes","maxTurnSourceBytes",
  "sourceBurstQuietMs","sourceBurstMaxMs","personalRulesFile"
]);
const MEDIA_INPUT_GATE_FIELDS=new Set([
  "nativeVoiceEnabled","audioFileEnabled","localVideoEnabled",
  "webPageEnabled","bilibiliEnabled","douyinEnabled"
]);
const PERSONAL_ASSISTANT_AI_TIMEOUTS=new Set([120_000,300_000]);
const DEEPSEEK_MODELS=new Set(["deepseek-v4-pro"]);
const DAILY_FIELDS=new Set(["enabled","skillRoot"]);
const INVOICE_FIELDS=new Set([
  "enabled","skillRoot","tempRoot","archiveRoot","maxFileBytes","aiTimeoutMs",
  "pdfProcessorPath","maxPdfPages","maxPdfTextBytes","maxPdfRenderBytes","pdfPrepareTimeoutMs"
]);
const KNOWLEDGE_FIELDS=new Set([
  "enabled","tempRoot","libraries","maxSourceBytes","aiTimeoutMs","inputFormats"
]);
const ASSISTANT_FIELDS=new Set([
  "enabled","tempRoot","workspaceRoot","outputRoot",
  "maxSearchFiles","maxSearchFileBytes",
  "maxSearchResults","maxSourceExcerptBytes","aiTimeoutMs",
  "maxOutputBytes","outputRetentionDays","allowedOutputFormats"
]);
const LIBRARY_FIELDS=new Set(["libraryKey","displayName","aliases","root"]);

export async function loadConfig(file,{requireBinding=true}={}) {
  const info=await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("unsafe_config_file");
  const config=normalizeLoadedConfig(JSON.parse(await readFile(file,"utf8")));
  validateConfig(config,requireBinding,file);
  if (await hasSymlinkIdentity(config.modelStateFile)) throw new Error("unsafe_model_state_path");
  return config;
}

export async function saveConfig(file,config,{requireBinding=true}={}) {
  validateConfig(config,requireBinding,file);
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const temporary=`${file}.${randomUUID()}.tmp`;
  const handle=await open(temporary,"wx",0o600);
  try { await handle.writeFile(`${JSON.stringify(config,null,2)}\n`,"utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary,file);
}

export function bindingFromEvent(event) {
  if (event?.chat_type !== "p2p" || event?.message_type !== "text" || event?.content !== "LLW-BIND-DAILY-WORK") return null;
  if (typeof event.sender_id !== "string" || !event.sender_id || typeof event.chat_id !== "string" || !event.chat_id) return null;
  return {senderId:event.sender_id,chatId:event.chat_id};
}

function validateConfig(config,requireBinding,configFile) {
  if (![4,5,6,7].includes(config?.version)) {
    throw new Error("invalid_config_version");
  }
  exact(
    config,
    config.version===7?V7_TOP_FIELDS:
      config.version===6?V6_TOP_FIELDS:
      config.version===5?V5_TOP_FIELDS:V4_TOP_FIELDS,
    "config"
  );
  for (const field of ["vaultRoot","stateFile","heartbeatFile","modelStateFile","wechatStateFile","cliPath","codexPath"]) absolute(config[field],field);
  if (config.version>=5) {
    exact(config.privateSkills,PRIVATE_SKILLS_FIELDS,"private_skills");
    absolute(config.privateSkills.root,"privateSkills.root");
    absolute(config.privateSkills.manifestPath,"privateSkills.manifestPath");
    if (config.privateSkills.manifestPath!==join(config.privateSkills.root,"manifest.json")) throw new Error("invalid_private_skills_manifest");
    if (typeof config.privateSkills.expectedManifestSha256!=="string"||!/^[0-9a-f]{64}$/.test(config.privateSkills.expectedManifestSha256)) throw new Error("invalid_private_skills_hash");
  }
  if (config.version>=6) {
    validatePersonalAssistantConfig(
      config.personalAssistant,config.vaultRoot
    );
  }
  if (config.version===7) {
    validateMediaInputGates(config.mediaInputGates);
  }
  if (typeof config.deepseekEnabled!=="boolean") throw new Error("invalid_deepseek_enabled");
  if (!DEEPSEEK_MODELS.has(config.deepseekModel)) throw new Error("invalid_deepseek_model");
  for (const field of ["deepseekKeychainService","deepseekKeychainAccount"]) if (typeof config[field]!=="string"||!/^[A-Za-z0-9._@-]{1,128}$/.test(config[field])) throw new Error("invalid_deepseek_keychain_name");
  if (typeof config.wechatEnabled!=="boolean") throw new Error("invalid_wechat_enabled");
  for (const field of ["wechatKeychainService","wechatKeychainAccount"]) if (typeof config[field]!=="string"||!/^[A-Za-z0-9._@-]{1,128}$/.test(config[field])) throw new Error("invalid_wechat_keychain_name");
  if (typeof config.profile !== "string" || !config.profile) throw new Error("invalid_profile");
  for (const field of ["senderId","chatId"]) {
    if (config[field] !== null && (typeof config[field] !== "string" || !config[field])) throw new Error(`invalid_binding:${field}`);
  }
  if (requireBinding && (!config.senderId || !config.chatId)) throw new Error("binding_missing");
  exact(
    config.capabilities,
    new Set(config.version>=5
      ?["daily-work","invoice","knowledge-ingest","assistant-work"]
      :["daily-work","invoice"]),
    "capabilities"
  );
  const daily=config.capabilities["daily-work"],invoice=config.capabilities.invoice;
  exact(daily,DAILY_FIELDS,"capability"); exact(invoice,INVOICE_FIELDS,"capability");
  if (typeof daily.enabled !== "boolean" || typeof invoice.enabled !== "boolean") throw new Error("invalid_capability_enabled");
  absolute(daily.skillRoot,"daily-work.skillRoot");
  for (const field of ["skillRoot","tempRoot","archiveRoot"]) absolute(invoice[field],`invoice.${field}`);
  absolute(invoice.pdfProcessorPath,"invoice.pdfProcessorPath");
  const knowledge=config.version>=5?config.capabilities["knowledge-ingest"]:null;
  if (knowledge) validateKnowledgeConfig(knowledge,config.vaultRoot);
  const assistant=config.version>=5?config.capabilities["assistant-work"]:null;
  if (assistant) validateAssistantConfig(
    assistant,{vaultRoot:config.vaultRoot,knowledge,invoice}
  );
  if (assistant) {
    const protectedFiles=[
      configFile,config.stateFile,config.heartbeatFile,config.modelStateFile,
      config.wechatStateFile,config.cliPath,config.codexPath,
      invoice.pdfProcessorPath
    ];
    for (const root of [
      assistant.tempRoot,assistant.workspaceRoot,assistant.outputRoot
    ]) {
      if (protectedFiles.some(file=>
        foldedPath(file)===foldedPath(root)||foldedInside(root,file)
      )) throw new Error("invalid_assistant_root");
    }
  }
  const privatePaths=config.version>=5
    ?[
      config.privateSkills.root,
      config.privateSkills.manifestPath,
      knowledge.tempRoot,
      ...knowledge.libraries.map(library=>library.root),
      assistant.tempRoot,
      assistant.workspaceRoot,
      assistant.outputRoot
      ,...(typeof config.personalAssistant?.personalRulesFile==="string"
        ?[config.personalAssistant.personalRulesFile]:[])
    ]
    :[];
  const protectedPaths=[configFile,config.vaultRoot,config.stateFile,config.heartbeatFile,config.wechatStateFile,config.cliPath,config.codexPath,daily.skillRoot,invoice.skillRoot,invoice.tempRoot,invoice.archiveRoot,invoice.pdfProcessorPath,...privatePaths];
  if (protectedPaths.filter(value=>typeof value==="string").some(value=>foldedPath(value)===foldedPath(config.modelStateFile))) throw new Error("invalid_model_state_file_alias");
  const nonWechatPaths=[configFile,config.vaultRoot,config.stateFile,config.heartbeatFile,config.modelStateFile,config.cliPath,config.codexPath,daily.skillRoot,invoice.skillRoot,invoice.tempRoot,invoice.archiveRoot,invoice.pdfProcessorPath,...privatePaths];
  if (nonWechatPaths.filter(value=>typeof value==="string").some(value=>foldedPath(value)===foldedPath(config.wechatStateFile))) throw new Error("invalid_wechat_state_file_alias");
  if (resolve(config.modelStateFile)!==resolve(join(dirname(config.stateFile),"model-state"))) throw new Error("invalid_model_state_file");
  if (invoice.archiveRoot !== join(config.vaultRoot,"亚信工作","日常发票","餐饮发票")) throw new Error("invalid_invoice_archive_root");
  if (invoice.maxFileBytes !== 20 * 1024 * 1024) throw new Error("invalid_max_file_bytes");
  if (invoice.aiTimeoutMs !== 120_000) throw new Error("invalid_ai_timeout");
  if (invoice.maxPdfPages !== 10) throw new Error("invalid_max_pdf_pages");
  if (invoice.maxPdfTextBytes !== 262_144) throw new Error("invalid_max_pdf_text_bytes");
  if (invoice.maxPdfRenderBytes !== 100 * 1024 * 1024) throw new Error("invalid_max_pdf_render_bytes");
  if (invoice.pdfPrepareTimeoutMs !== 60_000) throw new Error("invalid_pdf_prepare_timeout");
}

function validateMediaInputGates(value) {
  exact(value,MEDIA_INPUT_GATE_FIELDS,"media_input_gates");
  if (typeof value.bilibiliEnabled!=="boolean"||
      typeof value.douyinEnabled!=="boolean"||
      [
        "nativeVoiceEnabled","audioFileEnabled","localVideoEnabled",
        "webPageEnabled"
      ].some(field=>value[field]!==false)) {
    throw new Error("invalid_media_input_gates");
  }
}

function validatePersonalAssistantConfig(value,vaultRoot) {
  exact(value,PERSONAL_ASSISTANT_FIELDS,"personal_assistant");
  if (value.enabled!==true||
      value.skillName!=="llw-personal-assistant"||
      !PERSONAL_ASSISTANT_AI_TIMEOUTS.has(value.aiTimeoutMs)||
      value.maxContextBytes!==512*1024||
      value.maxSourcesPerTurn!==8||
      value.maxSourceFileBytes!==20*1024*1024||
      value.maxTurnSourceBytes!==80*1024*1024||
      value.sourceBurstQuietMs!==3_000||
      value.sourceBurstMaxMs!==15_000) {
    throw new Error("invalid_personal_assistant");
  }
  if (value.personalRulesFile!==null) {
    absolute(value.personalRulesFile,"personalAssistant.personalRulesFile");
    const privateRoot=join(vaultRoot,".llw-private");
    if (!foldedInside(privateRoot,value.personalRulesFile)||
        foldedPath(value.personalRulesFile)===foldedPath(privateRoot)) {
      throw new Error("invalid_personal_assistant_rules");
    }
  }
}

function validateAssistantConfig(assistant,{vaultRoot,knowledge,invoice}) {
  exact(assistant,ASSISTANT_FIELDS,"capability");
  if (typeof assistant.enabled!=="boolean") {
    throw new Error("invalid_assistant_enabled");
  }
  absolute(assistant.tempRoot,"assistant-work.tempRoot");
  absolute(assistant.workspaceRoot,"assistant-work.workspaceRoot");
  absolute(assistant.outputRoot,"assistant-work.outputRoot");
  for (const root of [
    assistant.tempRoot,assistant.workspaceRoot,assistant.outputRoot
  ]) {
    if (foldedInside(vaultRoot,root)) throw new Error("invalid_assistant_root");
  }
  const assistantRoots=[
    assistant.tempRoot,assistant.workspaceRoot,assistant.outputRoot
  ];
  const otherRoots=[knowledge.tempRoot,invoice.tempRoot];
  if (assistantRoots.some((root,index)=>assistantRoots.some(
    (other,otherIndex)=>index!==otherIndex&&foldedInside(root,other)
  ))||assistantRoots.some(root=>otherRoots.some(other=>
    foldedInside(root,other)||foldedInside(other,root)
  ))) {
    throw new Error("invalid_assistant_root");
  }
  if (assistant.maxSearchFiles!==512) {
    throw new Error("invalid_assistant_search_files");
  }
  if (assistant.maxSearchFileBytes!==262_144) {
    throw new Error("invalid_assistant_search_file_bytes");
  }
  if (assistant.maxSearchResults!==20) {
    throw new Error("invalid_assistant_search_results");
  }
  if (assistant.maxSourceExcerptBytes!==262_144) {
    throw new Error("invalid_assistant_source_bytes");
  }
  if (assistant.aiTimeoutMs!==120_000) {
    throw new Error("invalid_assistant_ai_timeout");
  }
  if (assistant.maxOutputBytes!==20*1024*1024) {
    throw new Error("invalid_assistant_output_bytes");
  }
  if (assistant.outputRetentionDays!==7) {
    throw new Error("invalid_assistant_output_retention");
  }
  if (!Array.isArray(assistant.allowedOutputFormats)||
      assistant.allowedOutputFormats.length!==3||
      assistant.allowedOutputFormats.some((value,index)=>
        value!==["docx","pptx","xlsx"][index]
      )) {
    throw new Error("invalid_assistant_output_formats");
  }
}

function validateKnowledgeConfig(knowledge,vaultRoot) {
  exact(knowledge,KNOWLEDGE_FIELDS,"capability");
  if (typeof knowledge.enabled!=="boolean") {
    throw new Error("invalid_knowledge_enabled");
  }
  absolute(knowledge.tempRoot,"knowledge-ingest.tempRoot");
  if (foldedInside(vaultRoot,knowledge.tempRoot)) throw new Error("invalid_knowledge_temp_root");
  if (!Array.isArray(knowledge.libraries)||knowledge.libraries.length<2||knowledge.libraries.length>16) {
    throw new Error("invalid_knowledge_libraries");
  }
  const keys=new Set(),names=new Set(),roots=[];
  for (const library of knowledge.libraries) {
    exact(library,LIBRARY_FIELDS,"knowledge_library");
    if (typeof library.libraryKey!=="string"||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(library.libraryKey)||
        keys.has(library.libraryKey)) {
      throw new Error("invalid_knowledge_library_key");
    }
    keys.add(library.libraryKey);
    validateLibraryLabel(library.displayName);
    if (!Array.isArray(library.aliases)||library.aliases.length>16) {
      throw new Error("invalid_knowledge_library_aliases");
    }
    for (const value of [library.displayName,...library.aliases]) {
      validateLibraryLabel(value);
      const folded=value.toLocaleLowerCase("en-US");
      if (names.has(folded)) throw new Error("duplicate_knowledge_library_alias");
      names.add(folded);
    }
    absolute(library.root,`knowledge-ingest.library.${library.libraryKey}`);
    if (!foldedInside(vaultRoot,library.root)||foldedPath(library.root)===foldedPath(vaultRoot)) {
      throw new Error("invalid_knowledge_library_root");
    }
    for (const other of roots) {
      if (foldedInside(other,library.root)||foldedInside(library.root,other)) {
        throw new Error("overlapping_knowledge_library_root");
      }
    }
    roots.push(library.root);
  }
  if (knowledge.maxSourceBytes!==262_144) throw new Error("invalid_knowledge_source_bytes");
  if (knowledge.aiTimeoutMs!==120_000) throw new Error("invalid_knowledge_ai_timeout");
  if (!Array.isArray(knowledge.inputFormats)||
      knowledge.inputFormats.length!==7||
      knowledge.inputFormats.some((value,index)=>
        value!==[
          "text","txt","md","docx","pptx","xlsx","feishu-snapshot"
        ][index]
      )) {
    throw new Error("invalid_knowledge_input_formats");
  }
}

function validateLibraryLabel(value) {
  if (typeof value!=="string"||value!==value.trim()||value!==value.normalize("NFC")||
      value.length<1||[...value].length>64||value.startsWith(".")||
      /[\\/\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("invalid_knowledge_library_label");
  }
}

function normalizeLoadedConfig(config) {
  if (!config || typeof config!=="object" || Array.isArray(config)) return config;
  const normalized={...config};
  if (!Object.hasOwn(normalized,"modelStateFile") && typeof normalized.stateFile==="string" && isAbsolute(normalized.stateFile)) normalized.modelStateFile=join(dirname(normalized.stateFile),"model-state");
  const missingDeepSeek=["deepseekModel","deepseekKeychainService","deepseekKeychainAccount"].some(field=>!Object.hasOwn(normalized,field));
  if (!Object.hasOwn(normalized,"deepseekEnabled")||missingDeepSeek) normalized.deepseekEnabled=false;
  if (!Object.hasOwn(normalized,"deepseekModel")) normalized.deepseekModel="deepseek-v4-pro";
  if (!Object.hasOwn(normalized,"deepseekKeychainService")) normalized.deepseekKeychainService="com.llw.deepseek-api";
  if (!Object.hasOwn(normalized,"deepseekKeychainAccount")) normalized.deepseekKeychainAccount="llw-assistant";
  const missingWechat=["wechatStateFile","wechatKeychainService","wechatKeychainAccount"].some(field=>!Object.hasOwn(normalized,field));
  if (!Object.hasOwn(normalized,"wechatEnabled")||missingWechat) normalized.wechatEnabled=false;
  if (!Object.hasOwn(normalized,"wechatStateFile")&&typeof normalized.stateFile==="string"&&isAbsolute(normalized.stateFile)) normalized.wechatStateFile=join(dirname(normalized.stateFile),"wechat-state.json");
  if (!Object.hasOwn(normalized,"wechatKeychainService")) normalized.wechatKeychainService="com.llw.wechat-ilink";
  if (!Object.hasOwn(normalized,"wechatKeychainAccount")) normalized.wechatKeychainAccount="llw-assistant";
  return normalized;
}

function foldedPath(value) { return resolve(value).toLocaleLowerCase("en-US"); }
function foldedInside(root,value) {
  const foldedRoot=foldedPath(root),foldedValue=foldedPath(value);
  return foldedValue===foldedRoot||foldedValue.startsWith(`${foldedRoot}/`);
}
async function hasSymlinkIdentity(file) {
  const absolute=resolve(file),root=parse(absolute).root;
  let current=root;
  for (const part of absolute.slice(root.length).split("/").filter(Boolean)) {
    current=join(current,part);
    try {
      const info=await lstat(current);
      if (info.isSymbolicLink() && !(process.platform==="darwin"&&current==="/var")) return true;
    } catch (error) { if (error.code==="ENOENT") return false; throw error; }
  }
  return false;
}

function exact(value,fields,label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid_${label}`);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new Error(label === "capability" ? "unknown_capability_field" : `unknown_${label}_field`);
  for (const key of fields) if (!Object.hasOwn(value,key)) throw new Error(`missing_${label}_field`);
}
function absolute(value,field) { if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`invalid_config_path:${field}`); }

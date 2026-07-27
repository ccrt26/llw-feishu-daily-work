const CANDIDATE_FIELDS=new Set([
  "action","confidence","reason_code","question","library_key","target",
  "folder_plan","title","summary","tags","knowledge_sections",
  "source_integrity","note_file","preserve_source"
]);
const TARGET_FIELDS=new Set(["scope","segments","origin"]);
const LEGACY_PLAN_FIELDS=new Set(["mode","segments","origin"]);
const SECTION_FIELDS=new Set([
  "key_facts","structure_and_main_content","reusable_content",
  "source_notes","content_index"
]);
const ACTIONS=new Set([
  "await_file","commit","create_folder","ask_user","reject"
]);
const REASONS=new Set([
  "ready","save_intent_missing","library_required","unsupported_format",
  "source_unreadable","source_incomplete","multiple_sources",
  "existing_change_forbidden","unsafe_instruction","folder_ready",
  "folder_confirmation_required","folder_operation_forbidden",
  "unsafe_folder_plan"
]);
const INTEGRITIES=new Set(["complete","partial","unreadable"]);
const WRAPPER_FIELDS=new Set(["result"]);

export function normalizeKnowledgeCandidate(candidate,{
  libraries,source,confirmedTarget=null
}) {
  try {
    if (candidate&&typeof candidate==="object"&&!Array.isArray(candidate)&&
        Object.keys(candidate).length===1&&
        Object.keys(candidate).every(key=>WRAPPER_FIELDS.has(key))) {
      candidate=candidate.result;
    }
    exactKnown(candidate,CANDIDATE_FIELDS);
    if (!ACTIONS.has(candidate.action)) throw new Error("invalid");
    const catalog=normalizeLibraries(libraries);
    let normalized;
    if (candidate.action==="commit") {
      normalized=normalizeCommit(candidate,catalog,source);
    } else if (candidate.action==="await_file") {
      normalized=normalizeAwaitFile(candidate,catalog,source);
    } else if (candidate.action==="create_folder") {
      normalized=normalizeCreateFolder(candidate,catalog,source);
    } else if (candidate.action==="ask_user") {
      normalized=normalizeAsk(candidate,catalog,source);
    } else {
      normalized=normalizeReject(candidate,source);
    }
    if (confirmedTarget&&
        new Set(["commit","create_folder"]).has(normalized.action)) {
      assertConfirmedTarget(normalized,confirmedTarget,catalog);
    }
    return normalized;
  } catch {
    throw new Error("knowledge_candidate_invalid");
  }
}

function assertConfirmedTarget(decisionValue,confirmedTarget,catalog) {
  exact(confirmedTarget,new Set(["libraryKey","target"]));
  const library=resolveLibrary(confirmedTarget.libraryKey,catalog,{required:true});
  const target=normalizeTarget(
    {target:confirmedTarget.target},library,{action:"commit"}
  );
  if (decisionValue.libraryKey!==library.libraryKey||
      decisionValue.target.scope!==target.scope||
      decisionValue.target.origin!==target.origin||
      !same(decisionValue.target.segments,target.segments)) {
    throw new Error("invalid");
  }
}

function normalizeCommit(value,catalog,source) {
  requireHigh(value);
  const extractionIntegrity=source?.extractionIntegrity??
    value.source_integrity??"complete";
  if ((value.reason_code??"ready")!=="ready"||
      extractionIntegrity!=="complete"||
      (value.source_integrity??"complete")!=="complete") {
    throw new Error("invalid");
  }
  const library=resolveLibrary(value.library_key,catalog,{required:true});
  const target=normalizeTarget(value,library,{action:"commit"});
  const title=boundedText(value.title,160);
  const summary=boundedText(value.summary,4000);
  const tags=boundedList(value.tags,{maxItems:20,maxLength:64});
  const knowledgeSections=normalizeSections(value.knowledge_sections);
  allowLegacyProgramFields(value,{commit:true});
  return decision({
    action:"commit",reasonCode:"ready",libraryKey:library.libraryKey,target,
    title,summary,tags,knowledgeSections,sourceIntegrity:"complete"
  });
}

function normalizeAwaitFile(value,catalog,source) {
  if (value.confidence!==undefined&&!new Set(["high","medium"]).has(value.confidence)) {
    throw new Error("invalid");
  }
  const library=resolveLibrary(value.library_key,catalog,{required:true});
  const target=normalizeTarget(value,library,{action:"await_file"});
  requireAbsentContent(value);
  allowLegacyProgramFields(value);
  return decision({
    action:"await_file",reasonCode:"source_incomplete",
    libraryKey:library.libraryKey,target,sourceIntegrity:"partial"
  });
}

function normalizeCreateFolder(value,catalog) {
  requireHigh(value);
  if ((value.reason_code??"folder_ready")!=="folder_ready") {
    throw new Error("invalid");
  }
  const library=resolveLibrary(value.library_key,catalog,{required:true});
  const target=normalizeTarget(value,library,{action:"create_folder"});
  if (target.scope!=="new_folder"||target.origin!=="user_explicit") {
    throw new Error("invalid");
  }
  requireAbsentContent(value);
  allowLegacyProgramFields(value);
  return decision({
    action:"create_folder",reasonCode:"folder_ready",
    libraryKey:library.libraryKey,target,sourceIntegrity:"complete"
  });
}

function normalizeAsk(value,catalog,source) {
  const reason=value.reason_code;
  if (!REASONS.has(reason)||reason==="ready"||reason==="folder_ready") {
    throw new Error("invalid");
  }
  const question=boundedText(value.question,200);
  const library=resolveLibrary(value.library_key,catalog,{required:false});
  const target=hasTarget(value)
    ?normalizeTarget(value,library,{action:"ask_user"}):null;
  if (reason==="folder_confirmation_required"&&
      (!library||target?.scope!=="new_folder"||
       target.origin!=="skill_suggested")) {
    throw new Error("invalid");
  }
  requireAbsentContent(value);
  allowLegacyProgramFields(value);
  return decision({
    action:"ask_user",reasonCode:reason,question,
    libraryKey:library?.libraryKey||"",target,
    sourceIntegrity:normalizedIntegrity(value,source)
  });
}

function normalizeReject(value,source) {
  const reason=value.reason_code;
  if (!REASONS.has(reason)||reason==="ready"||reason==="folder_ready") {
    throw new Error("invalid");
  }
  if (value.library_key&&!empty(value.library_key)||hasMeaningfulTarget(value)) {
    throw new Error("invalid");
  }
  requireAbsentContent(value);
  allowLegacyProgramFields(value);
  return decision({
    action:"reject",reasonCode:reason,target:null,
    sourceIntegrity:normalizedIntegrity(value,source)
  });
}

function decision({
  action,reasonCode,question="",libraryKey="",target=null,title="",
  summary="",tags=[],knowledgeSections=null,sourceIntegrity
}) {
  return {
    action,reasonCode,question,libraryKey,target,title,summary,
    tags:[...tags],
    knowledgeSections:knowledgeSections?structuredClone(knowledgeSections):null,
    sourceIntegrity
  };
}

function normalizeTarget(value,library,{action}) {
  if (value.target!==undefined&&value.folder_plan!==undefined) {
    throw new Error("invalid");
  }
  let target;
  if (value.target!==undefined) {
    exact(value.target,TARGET_FIELDS);
    target={
      scope:value.target.scope,
      segments:normalizeSegments(value.target.segments),
      origin:value.target.origin
    };
  } else if (value.folder_plan!==undefined) {
    exact(value.folder_plan,LEGACY_PLAN_FIELDS);
    const segments=normalizeSegments(value.folder_plan.segments);
    target={
      scope:value.folder_plan.mode==="create_if_missing"
        ?"new_folder":segments.length?"existing_folder":"library_root",
      segments,
      origin:value.folder_plan.origin
    };
  } else {
    throw new Error("invalid");
  }
  if (!new Set(["library_root","existing_folder","new_folder"]).has(target.scope)||
      !new Set(["user_explicit","skill_suggested"]).has(target.origin)) {
    throw new Error("invalid");
  }
  if (target.scope==="existing_folder"&&target.segments.length===1&&library&&
      library.labels.has(target.segments[0])) {
    target={...target,scope:"library_root",segments:[]};
  }
  if (target.scope==="library_root"&&target.segments.length) throw new Error("invalid");
  if (target.scope!=="library_root"&&!target.segments.length) throw new Error("invalid");
  if (target.scope==="existing_folder"&&
      !library.existingFolders.some(parts=>same(parts,target.segments))) {
    throw new Error("invalid");
  }
  if (target.scope==="new_folder"&&action!=="ask_user"&&
      target.origin!=="user_explicit") {
    throw new Error("invalid");
  }
  return target;
}

function normalizeSections(value) {
  exact(value,SECTION_FIELDS);
  return {
    keyFacts:boundedList(value.key_facts,{maxItems:50,maxLength:1000,minItems:1}),
    structureAndMainContent:boundedText(value.structure_and_main_content,16000),
    reusableContent:boundedList(value.reusable_content,{maxItems:50,maxLength:1000}),
    sourceNotes:boundedText(value.source_notes,4000),
    contentIndex:boundedText(value.content_index,16000)
  };
}

function normalizeLibraries(value) {
  if (!Array.isArray(value)||!value.length||value.length>16) {
    throw new Error("invalid");
  }
  const keys=new Set(),labels=new Map(),result=[];
  for (const item of value) {
    const fields=new Set([
      "libraryKey","displayName","aliases","existingFolders"
    ]);
    exact(item,fields);
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(item.libraryKey||"")||
        keys.has(item.libraryKey)||!bounded(item.displayName,128,false)||
        !Array.isArray(item.aliases)||item.aliases.length>16||
        !Array.isArray(item.existingFolders)) {
      throw new Error("invalid");
    }
    keys.add(item.libraryKey);
    const library={
      libraryKey:item.libraryKey,
      displayName:item.displayName,
      aliases:[],
      existingFolders:item.existingFolders.map(normalizeSegments),
      labels:new Set()
    };
    for (const label of [item.libraryKey,item.displayName,...item.aliases]) {
      const normalized=boundedText(label,128);
      library.labels.add(normalized);
      const matches=labels.get(normalized)||[];
      matches.push(library);
      labels.set(normalized,matches);
      if (label!==item.libraryKey&&label!==item.displayName) {
        library.aliases.push(label);
      }
    }
    result.push(library);
  }
  return {items:result,labels};
}

function resolveLibrary(value,catalog,{required}) {
  if (value===undefined||value==="") {
    if (required) throw new Error("invalid");
    return null;
  }
  const label=boundedText(value,128);
  const matches=catalog.labels.get(label)||[];
  if (matches.length!==1) throw new Error("invalid");
  return matches[0];
}

function requireHigh(value) {
  if ((value.confidence??"high")!=="high") throw new Error("invalid");
}

function requireAbsentContent(value) {
  if (!empty(value.title)||!empty(value.summary)||
      (value.tags!==undefined&&
       (!Array.isArray(value.tags)||value.tags.length))||
      value.knowledge_sections!==undefined) {
    throw new Error("invalid");
  }
}

function allowLegacyProgramFields(value,{commit=false}={}) {
  if (value.note_file!==undefined&&
      value.note_file!==(commit?"knowledge.md":"")) {
    throw new Error("invalid");
  }
  if (value.preserve_source!==undefined&&
      typeof value.preserve_source!=="boolean") {
    throw new Error("invalid");
  }
}

function normalizedIntegrity(value,source) {
  const integrity=value.source_integrity??source?.extractionIntegrity??"complete";
  if (!INTEGRITIES.has(integrity)) throw new Error("invalid");
  return integrity;
}

function normalizeSegments(value) {
  if (!Array.isArray(value)||value.length>5) throw new Error("invalid");
  return value.map(segment=>{
    const normalized=boundedText(segment,64);
    if (normalized!==normalized.normalize("NFC")||normalized==="."||
        normalized===".."||normalized.startsWith(".")||
        /[\\/\u0000-\u001f\u007f]/u.test(normalized)) {
      throw new Error("invalid");
    }
    return normalized;
  });
}

function boundedList(value,{maxItems,maxLength,minItems=0}) {
  if (!Array.isArray(value)||value.length<minItems||value.length>maxItems) {
    throw new Error("invalid");
  }
  const items=value.map(item=>boundedText(item,maxLength));
  if (new Set(items).size!==items.length) throw new Error("invalid");
  return items;
}

function boundedText(value,max) {
  if (!bounded(value,max,false)) throw new Error("invalid");
  return value.normalize("NFC").trim();
}

function bounded(value,max,allowEmpty) {
  return typeof value==="string"&&(allowEmpty||value.trim())&&
    value===value.trim()&&[...value].length<=max&&!value.includes("\0");
}

function exactKnown(value,allowed) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.getPrototypeOf(value)!==Object.prototype||
      Object.keys(value).some(key=>!allowed.has(key))) {
    throw new Error("invalid");
  }
}

function exact(value,fields) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.getPrototypeOf(value)!==Object.prototype||
      Object.keys(value).length!==fields.size||
      Object.keys(value).some(key=>!fields.has(key))) {
    throw new Error("invalid");
  }
}

function hasTarget(value) {
  return value.target!==undefined||value.folder_plan!==undefined;
}

function hasMeaningfulTarget(value) {
  if (!hasTarget(value)) return false;
  if (value.target!==undefined) return true;
  const plan=value.folder_plan;
  return !plan||plan.mode!=="use_existing"||plan.segments?.length||
    plan.origin!=="user_explicit";
}

function empty(value) {
  return value===undefined||value==="";
}

function same(left,right) {
  return left.length===right.length&&
    left.every((value,index)=>value===right[index]);
}

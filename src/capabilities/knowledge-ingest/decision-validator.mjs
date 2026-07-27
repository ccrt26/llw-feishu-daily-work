const TOP_FIELDS=new Set([
  "action","reasonCode","question","libraryKey","target","title","summary",
  "tags","knowledgeSections","sourceIntegrity"
]);
const TARGET_FIELDS=new Set(["scope","segments","origin"]);
const SECTION_FIELDS=new Set([
  "keyFacts","structureAndMainContent","reusableContent","sourceNotes",
  "contentIndex"
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

export function validateKnowledgeDecision(value,{libraries}) {
  try {
    exact(value,TOP_FIELDS);
    if (!ACTIONS.has(value.action)||!REASONS.has(value.reasonCode)||
        !bounded(value.question,200,true)||!bounded(value.title,160,true)||
        !bounded(value.summary,4000,true)||
        !Array.isArray(value.tags)||value.tags.length>20||
        new Set(value.tags).size!==value.tags.length||
        value.tags.some(tag=>!bounded(tag,64,false))||
        !INTEGRITIES.has(value.sourceIntegrity)) {
      throw new Error("invalid");
    }
    const catalog=validateLibraries(libraries);
    const library=value.libraryKey===""?null:catalog.get(value.libraryKey);
    if (value.libraryKey!==""&&!library) throw new Error("invalid");
    const target=value.target===null?null:validateTarget(value.target,library);
    const sections=value.knowledgeSections===null
      ?null:validateSections(value.knowledgeSections);
    if (value.action==="commit") validateCommit(value,target,sections,library);
    else if (value.action==="await_file") validateAwaitFile(value,target,sections,library);
    else if (value.action==="create_folder") {
      validateCreateFolder(value,target,sections,library);
    } else if (value.action==="ask_user") {
      validateAsk(value,target,sections,library);
    } else validateReject(value,target,sections);
    return structuredClone(value);
  } catch {
    throw new Error("knowledge_decision_invalid");
  }
}

function validateCommit(value,target,sections,library) {
  if (value.reasonCode!=="ready"||value.question!==""||!library||!target||
      !value.title||!value.summary||!sections||
      value.sourceIntegrity!=="complete") {
    throw new Error("invalid");
  }
  if (target.scope==="new_folder"&&target.origin!=="user_explicit") {
    throw new Error("invalid");
  }
}

function validateAwaitFile(value,target,sections,library) {
  if (value.reasonCode!=="source_incomplete"||value.question!==""||
      !library||!target||sections!==null||value.title!==""||
      value.summary!==""||value.tags.length||
      value.sourceIntegrity!=="partial") {
    throw new Error("invalid");
  }
}

function validateCreateFolder(value,target,sections,library) {
  if (value.reasonCode!=="folder_ready"||value.question!==""||!library||
      target?.scope!=="new_folder"||target.origin!=="user_explicit"||
      sections!==null||value.title!==""||value.summary!==""||
      value.tags.length||value.sourceIntegrity!=="complete") {
    throw new Error("invalid");
  }
}

function validateAsk(value,target,sections,library) {
  if (!value.question||sections!==null||value.title!==""||
      value.summary!==""||value.tags.length) {
    throw new Error("invalid");
  }
  if (value.reasonCode==="folder_confirmation_required") {
    if (!library||target?.scope!=="new_folder"||
        target.origin!=="skill_suggested") {
      throw new Error("invalid");
    }
  } else if (target!==null&&!library) {
    throw new Error("invalid");
  }
}

function validateReject(value,target,sections) {
  if (value.reasonCode==="ready"||value.reasonCode==="folder_ready"||
      value.question!==""||value.libraryKey!==""||target!==null||
      sections!==null||value.title!==""||value.summary!==""||
      value.tags.length) {
    throw new Error("invalid");
  }
}

function validateTarget(value,library) {
  exact(value,TARGET_FIELDS);
  if (!library||
      !new Set(["library_root","existing_folder","new_folder"]).has(value.scope)||
      !new Set(["user_explicit","skill_suggested"]).has(value.origin)||
      !Array.isArray(value.segments)||value.segments.length>5||
      value.segments.some(segment=>!validSegment(segment))) {
    throw new Error("invalid");
  }
  if (value.scope==="library_root"&&value.segments.length) throw new Error("invalid");
  if (value.scope!=="library_root"&&!value.segments.length) throw new Error("invalid");
  if (value.scope==="existing_folder"&&
      !library.existingFolders.some(candidate=>same(candidate,value.segments))) {
    throw new Error("invalid");
  }
  return value;
}

function validateSections(value) {
  exact(value,SECTION_FIELDS);
  if (!Array.isArray(value.keyFacts)||value.keyFacts.length<1||
      value.keyFacts.length>50||
      value.keyFacts.some(item=>!bounded(item,1000,false))||
      new Set(value.keyFacts).size!==value.keyFacts.length||
      !bounded(value.structureAndMainContent,16000,false)||
      !Array.isArray(value.reusableContent)||value.reusableContent.length>50||
      value.reusableContent.some(item=>!bounded(item,1000,false))||
      new Set(value.reusableContent).size!==value.reusableContent.length||
      !bounded(value.sourceNotes,4000,false)||
      !bounded(value.contentIndex,16000,false)) {
    throw new Error("invalid");
  }
  return value;
}

function validateLibraries(value) {
  if (!Array.isArray(value)||value.length<1||value.length>16) {
    throw new Error("invalid");
  }
  const result=new Map();
  for (const library of value) {
    exact(library,new Set([
      "libraryKey","displayName","aliases","existingFolders"
    ]));
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(library.libraryKey||"")||
        result.has(library.libraryKey)||!bounded(library.displayName,128,false)||
        !Array.isArray(library.aliases)||!Array.isArray(library.existingFolders)||
        library.existingFolders.some(parts=>!Array.isArray(parts)||
          parts.length<1||parts.length>5||
          parts.some(segment=>!validSegment(segment)))) {
      throw new Error("invalid");
    }
    result.set(library.libraryKey,library);
  }
  return result;
}

function validSegment(value) {
  return typeof value==="string"&&value===value.trim()&&
    value===value.normalize("NFC")&&[...value].length>=1&&
    [...value].length<=64&&value!=="."&&value!==".."&&
    !value.startsWith(".")&&!/[\\/\u0000-\u001f\u007f]/u.test(value);
}

function exact(value,fields) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.getPrototypeOf(value)!==Object.prototype||
      Object.keys(value).length!==fields.size||
      Object.keys(value).some(field=>!fields.has(field))) {
    throw new Error("invalid");
  }
}

function bounded(value,max,allowEmpty) {
  return typeof value==="string"&&(allowEmpty||value.length>0)&&
    value===value.trim()&&[...value].length<=max&&!value.includes("\0");
}

function same(left,right) {
  return left.length===right.length&&
    left.every((value,index)=>value===right[index]);
}

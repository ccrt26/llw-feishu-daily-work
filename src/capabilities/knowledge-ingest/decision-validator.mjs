const TOP_FIELDS=new Set([
  "action","confidence","reason_code","question","library_key","folder_plan",
  "title","summary","tags","note_file","source_integrity","preserve_source"
]);
const PLAN_FIELDS=new Set(["mode","segments","origin"]);
const ACTIONS=new Set(["commit","create_folder","ask_user","reject"]);
const CONFIDENCE=new Set(["high","medium","low"]);
const REASONS=new Set([
  "ready","save_intent_missing","library_required","unsupported_format",
  "source_unreadable","source_incomplete","multiple_sources",
  "existing_change_forbidden","unsafe_instruction","folder_ready",
  "folder_confirmation_required","folder_operation_forbidden",
  "unsafe_folder_plan"
]);

export function validateKnowledgeDecision(value,{libraries}) {
  try {
    exact(value,TOP_FIELDS);
    if (!ACTIONS.has(value.action)||!CONFIDENCE.has(value.confidence)||
        !REASONS.has(value.reason_code)||!bounded(value.question,200,true)||
        !bounded(value.title,160,true)||!bounded(value.summary,4000,true)||
        !Array.isArray(value.tags)||value.tags.length>20||
        new Set(value.tags).size!==value.tags.length||
        value.tags.some(tag=>!bounded(tag,64,false))||
        !new Set(["","knowledge.md"]).has(value.note_file)||
        !new Set(["complete","partial","unreadable"]).has(value.source_integrity)||
        typeof value.preserve_source!=="boolean") {
      throw new Error("invalid");
    }
    const catalog=validateLibraries(libraries);
    const plan=validatePlan(value.folder_plan);
    const library=value.library_key===""?null:catalog.get(value.library_key);
    if (value.library_key!==""&&!library) throw new Error("invalid");
    if (plan.mode==="use_existing"&&plan.segments.length) {
      if (!library||!library.existingFolders.some(candidate=>same(candidate,plan.segments))) {
        throw new Error("invalid");
      }
    }
    if (value.action==="commit") validateCommit(value,plan,library);
    else if (value.action==="create_folder") validateCreateFolder(value,plan,library);
    else if (value.action==="ask_user") validateAsk(value,plan,library);
    else validateReject(value,plan);
    return structuredClone(value);
  } catch {
    throw new Error("knowledge_decision_invalid");
  }
}

function validateCommit(value,plan,library) {
  if (value.confidence!=="high"||value.reason_code!=="ready"||value.question!==""||
      !library||!value.title||!value.summary||value.note_file!=="knowledge.md"||
      value.source_integrity!=="complete") {
    throw new Error("invalid");
  }
  if (plan.mode==="create_if_missing"&&plan.origin!=="user_explicit") {
    throw new Error("invalid");
  }
}

function validateCreateFolder(value,plan,library) {
  if (value.confidence!=="high"||value.reason_code!=="folder_ready"||
      value.question!==""||!library||plan.mode!=="create_if_missing"||
      plan.origin!=="user_explicit"||value.title!==""||value.summary!==""||
      value.tags.length||value.note_file!==""||value.source_integrity!=="complete"||
      value.preserve_source!==false) {
    throw new Error("invalid");
  }
}

function validateAsk(value,plan,library) {
  if (!value.question||value.title!==""||value.summary!==""||
      value.tags.length||value.note_file!=="") {
    throw new Error("invalid");
  }
  if (value.reason_code==="folder_confirmation_required") {
    if (!library||plan.mode!=="create_if_missing"||plan.origin!=="skill_suggested") {
      throw new Error("invalid");
    }
    return;
  }
  if (library||plan.mode!=="use_existing"||plan.segments.length||
      plan.origin!=="user_explicit") {
    throw new Error("invalid");
  }
}

function validateReject(value,plan) {
  if (value.question!==""||value.library_key!==""||plan.mode!=="use_existing"||
      plan.segments.length||plan.origin!=="user_explicit"||
      value.title!==""||value.summary!==""||value.tags.length||
      value.note_file!=="") {
    throw new Error("invalid");
  }
}

function validatePlan(value) {
  exact(value,PLAN_FIELDS);
  if (!new Set(["use_existing","create_if_missing"]).has(value.mode)||
      !new Set(["user_explicit","skill_suggested"]).has(value.origin)||
      !Array.isArray(value.segments)||value.segments.length>5||
      value.segments.some(segment=>!validSegment(segment))||
      value.mode==="create_if_missing"&&!value.segments.length) {
    throw new Error("invalid");
  }
  return value;
}

function validateLibraries(value) {
  if (!Array.isArray(value)||value.length<1) throw new Error("invalid");
  const result=new Map();
  for (const library of value) {
    const fields=new Set(["libraryKey","displayName","aliases","existingFolders"]);
    exact(library,fields);
    if (typeof library.libraryKey!=="string"||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(library.libraryKey)||
        result.has(library.libraryKey)||typeof library.displayName!=="string"||
        !Array.isArray(library.aliases)||!Array.isArray(library.existingFolders)||
        library.existingFolders.some(parts=>!Array.isArray(parts)||
          parts.length<1||parts.length>5||parts.some(segment=>!validSegment(segment)))) {
      throw new Error("invalid");
    }
    result.set(library.libraryKey,library);
  }
  return result;
}

function validSegment(value) {
  return typeof value==="string"&&value===value.trim()&&value===value.normalize("NFC")&&
    [...value].length>=1&&[...value].length<=64&&value!=="."&&value!==".."&&
    !value.startsWith(".")&&!/[\\/\u0000-\u001f\u007f]/u.test(value);
}

function exact(value,fields) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length!==fields.size||
      Object.keys(value).some(field=>!fields.has(field))) {
    throw new Error("invalid");
  }
}

function bounded(value,max,allowEmpty) {
  return typeof value==="string"&&(allowEmpty||value.length>0)&&
    [...value].length<=max&&!value.includes("\0");
}

function same(left,right) {
  return left.length===right.length&&left.every((value,index)=>value===right[index]);
}

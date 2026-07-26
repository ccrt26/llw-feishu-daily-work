const SESSION_FIELDS=new Set([
  "version","session_id","capability","status","model","goal","task_summary",
  "confirmed_requirements","rejected_directions","source_paths",
  "current_draft_version","recent_turns","started_at","updated_at"
]);
const POLICY_FIELDS=new Set(["capability","models"]);
const TURN_FIELDS=new Set(["role","text"]);
const STATUSES=new Set(["open","completed","cancelled","expired"]);
const MODELS=new Set(["codex","deepseek"]);
const ROLES=new Set(["user","assistant"]);
const CAPABILITY=/^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_V4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SESSION_BYTES=32 * 1024;

export function validateTaskSession(value,options) {
  try { return validate(value,options); }
  catch { throw new Error("invalid_task_session"); }
}

function validate(value,options) {
  exact(options,new Set(["policy","verifiedSourcePaths"]));
  const allowed=validatePolicy(options.policy);
  const verified=validateVerifiedPaths(options.verifiedSourcePaths);
  exact(value,SESSION_FIELDS);

  fail(value.version!==1);
  fail(typeof value.session_id!=="string"||!UUID_V4.test(value.session_id));
  fail(typeof value.capability!=="string"||!CAPABILITY.test(value.capability));
  fail(!STATUSES.has(value.status)||!MODELS.has(value.model));
  const capabilityPolicy=allowed.get(value.capability);
  fail(!capabilityPolicy||!capabilityPolicy.has(value.model));

  requiredText(value.goal,1000);
  optionalText(value.task_summary,8000);
  stringList(value.confirmed_requirements,{maxItems:20,maxBytes:1000});
  stringList(value.rejected_directions,{maxItems:20,maxBytes:1000});
  pathList(value.source_paths,{maxItems:20});
  fail(value.source_paths.some(path=>!verified.has(path)));

  fail(!Number.isInteger(value.current_draft_version)||
    value.current_draft_version<0||value.current_draft_version>1_000_000);
  fail(!Array.isArray(value.recent_turns)||value.recent_turns.length>12);
  for (const turn of value.recent_turns) {
    exact(turn,TURN_FIELDS);
    fail(!ROLES.has(turn.role));
    requiredText(turn.text,2000);
  }

  canonicalIso(value.started_at);
  canonicalIso(value.updated_at);
  fail(Date.parse(value.updated_at)<Date.parse(value.started_at));
  fail(Buffer.byteLength(JSON.stringify(value),"utf8")>MAX_SESSION_BYTES);
  return structuredClone(value);
}

function validatePolicy(value) {
  fail(!Array.isArray(value)||value.length<1||value.length>64);
  const result=new Map();
  for (const entry of value) {
    exact(entry,POLICY_FIELDS);
    fail(typeof entry.capability!=="string"||!CAPABILITY.test(entry.capability)||
      result.has(entry.capability));
    fail(!Array.isArray(entry.models)||entry.models.length<1||entry.models.length>2||
      new Set(entry.models).size!==entry.models.length||
      entry.models.some(model=>!MODELS.has(model)));
    result.set(entry.capability,new Set(entry.models));
  }
  return result;
}

function validateVerifiedPaths(value) {
  fail(!Array.isArray(value)||value.length>64||new Set(value).size!==value.length);
  for (const path of value) safePath(path);
  return new Set(value);
}

function stringList(value,{maxItems,maxBytes}) {
  fail(!Array.isArray(value)||value.length>maxItems||new Set(value).size!==value.length);
  for (const item of value) requiredText(item,maxBytes);
}

function pathList(value,{maxItems}) {
  fail(!Array.isArray(value)||value.length>maxItems||new Set(value).size!==value.length);
  for (const path of value) safePath(path);
}

function safePath(value) {
  requiredText(value,240);
  fail(value.startsWith("/")||value.startsWith("~")||value.includes("\\")||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value));
  const segments=value.split("/");
  fail(segments.some(segment=>!segment||segment==="."||segment===".."));
}

function requiredText(value,maxBytes) {
  fail(typeof value!=="string"||!value.trim()||Buffer.byteLength(value,"utf8")>maxBytes);
}

function optionalText(value,maxBytes) {
  fail(typeof value!=="string"||Buffer.byteLength(value,"utf8")>maxBytes||
    (value.length>0&&!value.trim()));
}

function canonicalIso(value) {
  fail(typeof value!=="string"||!Number.isFinite(Date.parse(value))||
    new Date(value).toISOString()!==value);
}

function exact(value,fields) {
  fail(!isPlainObject(value));
  const keys=Object.keys(value);
  fail(keys.length!==fields.size||keys.some(key=>!fields.has(key)));
}

function isPlainObject(value) {
  return value!==null&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype;
}

function fail(condition) {
  if (condition) throw new Error("invalid");
}

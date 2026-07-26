const VALUE_FIELDS=new Set(["library_key","folder_plan"]);
const PLAN_FIELDS=new Set(["mode","segments","origin"]);
const OPTION_FIELDS=new Set(["allowedLibraryKeys"]);
const LIBRARY_KEY=/^[a-z][a-z0-9_-]{0,63}$/;
const MODES=new Set(["use_existing","create_if_missing"]);
const ORIGINS=new Set(["user_explicit","skill_suggested"]);
const RESERVED=/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function validateManagedFolderPlan(value,options) {
  try { return validate(value,options); }
  catch { throw new Error("invalid_managed_folder_plan"); }
}

function validate(value,options) {
  exact(options,OPTION_FIELDS);
  const allowed=options.allowedLibraryKeys;
  fail(!Array.isArray(allowed)||allowed.length<1||allowed.length>64||
    new Set(allowed).size!==allowed.length||
    allowed.some(key=>typeof key!=="string"||!LIBRARY_KEY.test(key)));

  exact(value,VALUE_FIELDS);
  fail(typeof value.library_key!=="string"||!allowed.includes(value.library_key));
  exact(value.folder_plan,PLAN_FIELDS);
  const {mode,segments,origin}=value.folder_plan;
  fail(!MODES.has(mode)||!ORIGINS.has(origin)||
    !Array.isArray(segments)||segments.length>5);
  for (const segment of segments) validateSegment(segment);

  if (mode==="use_existing") {
    fail(segments.length!==0);
    return {
      libraryKey:value.library_key,
      operation:"use_existing",
      segments:[],
      risk:"none",
      requiresConfirmation:false
    };
  }

  fail(segments.length===0);
  const requiresConfirmation=origin==="skill_suggested";
  return {
    libraryKey:value.library_key,
    operation:"create_empty_directories",
    segments:[...segments],
    risk:requiresConfirmation?"confirmation_required":"low",
    requiresConfirmation
  };
}

function validateSegment(value) {
  fail(typeof value!=="string"||value.trim()!==value||
    value.normalize("NFC")!==value||
    [...value].length<1||[...value].length>64||
    Buffer.byteLength(value,"utf8")>160||
    value.startsWith(".")||value.endsWith(".")||
    /[\\/\u0000-\u001f\u007f]/u.test(value)||
    RESERVED.test(value.split(".")[0]));
}

function exact(value,fields) {
  fail(!value||typeof value!=="object"||Array.isArray(value)||
    Object.getPrototypeOf(value)!==Object.prototype);
  const keys=Object.keys(value);
  fail(keys.length!==fields.size||keys.some(key=>!fields.has(key)));
}

function fail(condition) {
  if (condition) throw new Error("invalid");
}

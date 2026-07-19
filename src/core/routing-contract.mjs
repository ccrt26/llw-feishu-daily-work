import {readFile} from "node:fs/promises";
import {join} from "node:path";

const FIELDS=new Set(["capability","purpose","accepts","positive_examples","negative_examples","supports_continuation"]);
const ACCEPTS=new Set(["text","image","file"]);

export async function loadRoutingContract(skillRoot,expectedCapability) {
  const parsed=JSON.parse(await readFile(join(skillRoot,"references","routing-contract.json"),"utf8"));
  return validateRoutingContract(parsed,expectedCapability);
}

export function validateRoutingContract(value,expectedCapability) {
  fail(!value || typeof value!=="object" || Array.isArray(value));
  fail(Object.keys(value).length!==FIELDS.size || Object.keys(value).some(key=>!FIELDS.has(key)));
  fail(typeof value.capability!=="string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.capability) || value.capability!==expectedCapability);
  fail(typeof value.purpose!=="string" || !value.purpose.trim() || value.purpose.length>500);
  fail(!Array.isArray(value.accepts) || value.accepts.length===0 || new Set(value.accepts).size!==value.accepts.length || value.accepts.some(item=>!ACCEPTS.has(item)));
  for (const field of ["positive_examples","negative_examples"]) fail(!Array.isArray(value[field]) || value[field].length===0 || value[field].length>20 || value[field].some(item=>typeof item!=="string" || !item.trim() || item.length>500));
  fail(typeof value.supports_continuation!=="boolean");
  return structuredClone(value);
}

function fail(condition) { if (condition) throw new Error("invalid_routing_contract"); }

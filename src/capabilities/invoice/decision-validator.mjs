const BUYER_NAME="亚信科技（成都）有限公司";
const BUYER_TAX_ID="91510100732356360H";
const TOP_FIELDS=new Set(["invoice","field_quality","category","document_verification"]);
const INVOICE_FIELDS=new Set([
  "invoice_number","issue_date","buyer_name","buyer_tax_id",
  "seller_name","item_name","total_with_tax"
]);
const QUALITY_RESULTS=new Set(["clear","missing","unclear"]);
const CATEGORIES=new Set(["dining","non_dining","uncertain"]);
const DOCUMENT_RESULTS=new Set(["single_invoice","multiple_invoices","conflicting_fields","unclear"]);

export function validateInvoiceExtraction(extraction) {
  exactObject(extraction,TOP_FIELDS,"extraction");
  exactObject(extraction.invoice,INVOICE_FIELDS,"invoice");
  exactObject(extraction.field_quality,INVOICE_FIELDS,"field_quality");
  if (!CATEGORIES.has(extraction.category)) throw new Error("invalid_category");
  if (!DOCUMENT_RESULTS.has(extraction.document_verification)) throw new Error("invalid_document_verification");

  for (const field of INVOICE_FIELDS) {
    const value=extraction.invoice[field];
    const quality=extraction.field_quality[field];
    if (typeof value !== "string") throw new Error("invalid_invoice_text");
    if (!QUALITY_RESULTS.has(quality)) throw new Error("invalid_field_quality");
    if ((quality === "clear" && !value.trim()) ||
        (quality !== "clear" && value !== "")) {
      throw new Error("invalid_field_quality_value_pair");
    }
  }
  return structuredClone(extraction);
}

export function deriveInvoiceRuleDecision(extraction) {
  const documentReason={
    multiple_invoices:"multiple_invoices",
    conflicting_fields:"conflicting_fields",
    unclear:"document_unclear"
  }[extraction.document_verification];
  if (documentReason) return clarify(documentReason);

  const qualities=Object.values(extraction.field_quality);
  if (qualities.includes("missing")) return clarify("required_field_missing");
  if (qualities.includes("unclear")) return clarify("required_field_unclear");

  const nameMatches=extraction.invoice.buyer_name===BUYER_NAME;
  const taxMatches=extraction.invoice.buyer_tax_id===BUYER_TAX_ID;
  if (!nameMatches && !taxMatches) return reject("buyer_identity_mismatch");
  if (!nameMatches) return reject("buyer_name_mismatch");
  if (!taxMatches) return reject("buyer_tax_id_mismatch");

  if (extraction.category === "non_dining") return reject("non_dining");
  if (extraction.category === "uncertain") return clarify("category_uncertain");
  if (!/^[A-Za-z0-9]{1,32}$/.test(extraction.invoice.invoice_number)) {
    return clarify("invoice_number_invalid");
  }
  const issueDate=normalizeIssueDate(extraction.invoice.issue_date);
  if (!issueDate) return clarify("issue_date_invalid");
  if (!validAmount(extraction.invoice.total_with_tax)) return clarify("total_invalid");

  return {
    action:"archive_dining",
    reasonCode:"eligible",
    invoice:{...structuredClone(extraction.invoice),issue_date:issueDate}
  };
}

function reject(reasonCode) {
  return {action:"reject",reasonCode};
}

function clarify(reasonCode) {
  return {action:"needs_clarification",reasonCode};
}

function exactObject(value,fields,label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid_${label}`);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new Error(`unknown_${label}_field`);
  for (const key of fields) if (!Object.hasOwn(value,key)) throw new Error(`missing_${label}_field`);
}

function normalizeIssueDate(value) {
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value) ||
    /^(\d{4})年(\d{2})月(\d{2})日$/.exec(value);
  if (!match) return null;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const date=new Date(Date.UTC(year,month-1,day));
  if (date.getUTCFullYear()!==year ||
      date.getUTCMonth()!==month-1 ||
      date.getUTCDate()!==day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function validAmount(value) {
  return /^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value) && Number(value)>0;
}

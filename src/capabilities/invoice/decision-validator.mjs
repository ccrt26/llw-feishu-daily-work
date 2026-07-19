const BUYER_NAME="亚信科技（成都）有限公司";
const BUYER_TAX_ID="91510100732356360H";
const TOP_FIELDS=new Set(["action","confidence","reason","question","invoice","buyer_verification","category","document_verification"]);
const INVOICE_FIELDS=new Set(["invoice_number","issue_date","buyer_name","buyer_tax_id","seller_name","item_name","total_with_tax","file_format"]);
const ACTIONS=new Set(["archive_dining","needs_clarification","reject"]);
const CONFIDENCE=new Set(["high","medium","low"]);
const BUYER_RESULTS=new Set(["exact_match","name_missing","name_unclear","name_mismatch","tax_id_missing","tax_id_unclear","tax_id_mismatch"]);
const CATEGORIES=new Set(["dining","non_dining","uncertain"]);
const DOCUMENT_RESULTS=new Set(["single_invoice","multiple_invoices","conflicting_fields","unclear"]);
const FORMATS=new Set(["jpeg","png","webp","pdf"]);

export function validateInvoiceDecision(decision,{detectedFormat}) {
  exactObject(decision,TOP_FIELDS,"decision");
  exactObject(decision.invoice,INVOICE_FIELDS,"invoice");
  if (!ACTIONS.has(decision.action)) throw new Error("invalid_action");
  if (!CONFIDENCE.has(decision.confidence)) throw new Error("invalid_confidence");
  if (!BUYER_RESULTS.has(decision.buyer_verification)) throw new Error("invalid_buyer_verification");
  if (!CATEGORIES.has(decision.category)) throw new Error("invalid_category");
  if (!DOCUMENT_RESULTS.has(decision.document_verification)) throw new Error("invalid_document_verification");
  for (const field of ["reason","question"]) if (typeof decision[field] !== "string") throw new Error("invalid_decision_text");
  if (!decision.reason.trim()) throw new Error("reason_required");
  for (const field of INVOICE_FIELDS) if (typeof decision.invoice[field] !== "string") throw new Error("invalid_invoice_text");
  if (!FORMATS.has(decision.invoice.file_format) || decision.invoice.file_format !== detectedFormat) throw new Error("format_mismatch");
  if (detectedFormat !== "pdf" && decision.document_verification !== "single_invoice") throw new Error("invalid_document_verification_for_format");

  const invoice=decision.invoice;
  if (invoice.invoice_number && !/^[A-Za-z0-9]{1,32}$/.test(invoice.invoice_number)) throw new Error("invalid_invoice_number");
  if (invoice.issue_date && !validDate(invoice.issue_date)) throw new Error("invalid_issue_date");
  if (invoice.total_with_tax && !validAmount(invoice.total_with_tax)) throw new Error("invalid_total");

  if (decision.action === "needs_clarification") {
    if (!decision.question.trim()) throw new Error("question_required");
  } else if (decision.question !== "") throw new Error("unexpected_question");

  if (decision.action === "archive_dining") {
    if (decision.document_verification !== "single_invoice") throw new Error("unsafe_document_verification");
    if (decision.confidence !== "high") throw new Error("unsafe_archive_confidence");
    if (decision.buyer_verification !== "exact_match") throw new Error("unsafe_buyer_verification");
    if (invoice.buyer_name !== BUYER_NAME) throw new Error("buyer_name_mismatch");
    if (invoice.buyer_tax_id !== BUYER_TAX_ID) throw new Error("buyer_tax_id_mismatch");
    if (decision.category !== "dining") throw new Error("unsafe_invoice_category");
    if (!/^[A-Za-z0-9]{1,32}$/.test(invoice.invoice_number)) throw new Error("invoice_number_required");
    if (!validDate(invoice.issue_date)) throw new Error("issue_date_required");
    if (!invoice.seller_name || !invoice.item_name) throw new Error("invoice_text_required");
    if (!validAmount(invoice.total_with_tax)) throw new Error("total_required");
  }
  return structuredClone(decision);
}

function exactObject(value,fields,label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid_${label}`);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new Error(`unknown_${label}_field`);
  for (const key of fields) if (!Object.hasOwn(value,key)) throw new Error(`missing_${label}_field`);
}

function validDate(value) {
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month-1 && date.getUTCDate() === day;
}

function validAmount(value) {
  return /^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value) && Number(value) > 0;
}

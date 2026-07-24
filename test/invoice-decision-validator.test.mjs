import test from "node:test";
import assert from "node:assert/strict";
import {validateInvoiceDecision} from "../src/capabilities/invoice/decision-validator.mjs";

function validDecision() {
  return {
    action:"archive_dining", confidence:"high", reason:"票面字段清晰且餐饮类别明确", question:"",
    invoice:{invoice_number:"123456789012",issue_date:"2026-07-18",buyer_name:"亚信科技（成都）有限公司",buyer_tax_id:"91510100732356360H",seller_name:"成都餐饮有限公司",item_name:"餐饮服务",total_with_tax:"290.00",file_format:"png"},
    buyer_verification:"exact_match", category:"dining", document_verification:"single_invoice"
  };
}

test("authorizes only a complete exact dining invoice", () => {
  assert.deepEqual(validateInvoiceDecision(validDecision(),{detectedFormat:"png"}),validDecision());
});

test("rejects every unsafe archive mutation", () => {
  const cases = [
    d => { d.invoice.buyer_name="亚信科技(成都)有限公司"; },
    d => { d.invoice.buyer_tax_id="915101007323563600"; },
    d => { delete d.invoice.seller_name; },
    d => { d.confidence="medium"; },
    d => { d.category="non_dining"; },
    d => { d.invoice.invoice_number="12-34"; },
    d => { d.invoice.issue_date="2026-02-30"; },
    d => { d.invoice.total_with_tax="0.00"; },
    d => { d.invoice.total_with_tax="290.001"; },
    d => { d.invoice.file_format="jpeg"; },
    d => { d.question="是否归档？"; },
    d => { d.invoice.extra="unsafe"; },
    d => { d.extra="unsafe"; },
    d => { d.buyer_verification="name_unclear"; },
    d => { d.invoice.item_name=""; }
  ];
  for (const mutate of cases) {
    const decision=validDecision(); mutate(decision);
    assert.throws(() => validateInvoiceDecision(decision,{detectedFormat:"png"}));
  }
});

test("validates non-writing decisions but never turns them into archive permission", () => {
  const unclear=validDecision();
  unclear.action="needs_clarification"; unclear.confidence="low"; unclear.question="购买方税号无法辨认，请重新发送清晰票面。";
  unclear.invoice.buyer_tax_id=""; unclear.buyer_verification="tax_id_unclear"; unclear.category="uncertain";
  assert.equal(validateInvoiceDecision(unclear,{detectedFormat:"png"}).action,"needs_clarification");

  const rejected=validDecision();
  rejected.action="reject"; rejected.reason="购买方名称不匹配"; rejected.invoice.buyer_name="其他公司"; rejected.buyer_verification="name_mismatch";
  assert.equal(validateInvoiceDecision(rejected,{detectedFormat:"png"}).action,"reject");
  assert.throws(() => validateInvoiceDecision({...rejected,question:"说明一下"},{detectedFormat:"png"}),/unexpected_question/);
  assert.throws(() => validateInvoiceDecision({...unclear,question:""},{detectedFormat:"png"}),/question_required/);
});

test("non-writing decisions do not apply archive filename and value formatting rules", () => {
  const rejected=validDecision();
  rejected.action="reject";
  rejected.reason="购买方名称不匹配";
  rejected.invoice.buyer_name="其他公司";
  rejected.invoice.invoice_number="TEST-20260724-001";
  rejected.invoice.issue_date="2026年07月24日";
  rejected.invoice.total_with_tax="¥200.00";
  rejected.buyer_verification="name_mismatch";
  assert.equal(validateInvoiceDecision(rejected,{detectedFormat:"png"}).action,"reject");
});

test("pdf archive requires exactly one consistent invoice", () => {
  const pdf=validDecision();
  pdf.invoice.file_format="pdf";
  assert.equal(validateInvoiceDecision(pdf,{detectedFormat:"pdf"}).document_verification,"single_invoice");
  for (const state of ["multiple_invoices","conflicting_fields","unclear"]) {
    const unsafe=structuredClone(pdf);
    unsafe.document_verification=state;
    assert.throws(() => validateInvoiceDecision(unsafe,{detectedFormat:"pdf"}),/unsafe_document_verification/);
  }
});

test("document verification is required, exact and action-compatible", () => {
  const missing=validDecision(); delete missing.document_verification;
  assert.throws(() => validateInvoiceDecision(missing,{detectedFormat:"png"}),/missing_decision_field/);
  const invalid=validDecision(); invalid.document_verification="invented";
  assert.throws(() => validateInvoiceDecision(invalid,{detectedFormat:"png"}),/invalid_document_verification/);
  for (const state of ["multiple_invoices","conflicting_fields","unclear"]) {
    const clarify=validDecision();
    clarify.action="needs_clarification"; clarify.confidence="low";
    clarify.invoice.file_format="pdf";
    clarify.document_verification=state; clarify.question="请重新发送一张发票一个文件的完整原件。";
    assert.equal(validateInvoiceDecision(clarify,{detectedFormat:"pdf"}).action,"needs_clarification");
  }
});

test("non-PDF inputs cannot claim multi-page PDF document states", () => {
  for (const state of ["multiple_invoices","conflicting_fields","unclear"]) {
    const decision=validDecision();
    decision.action="needs_clarification"; decision.confidence="low";
    decision.document_verification=state; decision.question="请重新发送完整原件。";
    assert.throws(() => validateInvoiceDecision(decision,{detectedFormat:"png"}),/invalid_document_verification_for_format/);
  }
});

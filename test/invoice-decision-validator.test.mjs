import test from "node:test";
import assert from "node:assert/strict";
import {
  validateInvoiceExtraction,
  deriveInvoiceRuleDecision
} from "../src/capabilities/invoice/decision-validator.mjs";

const FIELDS=[
  "invoice_number","issue_date","buyer_name","buyer_tax_id",
  "seller_name","item_name","total_with_tax"
];

function clearExtraction(overrides={}) {
  return {
    invoice:{
      invoice_number:"123456789012",
      issue_date:"2026-07-18",
      buyer_name:"亚信科技（成都）有限公司",
      buyer_tax_id:"91510100732356360H",
      seller_name:"测试餐饮有限公司",
      item_name:"餐饮服务",
      total_with_tax:"290.00",
      ...(overrides.invoice||{})
    },
    field_quality:{
      invoice_number:"clear",
      issue_date:"clear",
      buyer_name:"clear",
      buyer_tax_id:"clear",
      seller_name:"clear",
      item_name:"clear",
      total_with_tax:"clear",
      ...(overrides.field_quality||{})
    },
    category:overrides.category??"dining",
    document_verification:overrides.document_verification??"single_invoice"
  };
}

function assertNoArchive(decision,reasonCode) {
  assert.equal(decision.reasonCode,reasonCode);
  assert.notEqual(decision.action,"archive_dining");
  assert.equal(Object.hasOwn(decision,"invoice"),false);
}

test("validates and deep-clones only the exact InvoiceExtraction shape", () => {
  const extraction=clearExtraction();
  const validated=validateInvoiceExtraction(extraction);
  assert.deepEqual(validated,extraction);
  assert.notEqual(validated,extraction);
  assert.notEqual(validated.invoice,extraction.invoice);

  assert.throws(
    () => validateInvoiceExtraction({...extraction,action:"archive_dining"}),
    /unknown_extraction_field/
  );
  const missing=clearExtraction();
  delete missing.field_quality.seller_name;
  assert.throws(() => validateInvoiceExtraction(missing),/missing_field_quality_field/);
});

test("requires every value and quality pair to be internally consistent", () => {
  for (const field of FIELDS) {
    assert.throws(
      () => validateInvoiceExtraction(clearExtraction({
        invoice:{[field]:""},
        field_quality:{[field]:"clear"}
      })),
      /invalid_field_quality_value_pair/
    );
    assert.throws(
      () => validateInvoiceExtraction(clearExtraction({
        field_quality:{[field]:"missing"}
      })),
      /invalid_field_quality_value_pair/
    );
    assert.throws(
      () => validateInvoiceExtraction(clearExtraction({
        field_quality:{[field]:"invented"}
      })),
      /invalid_field_quality/
    );
  }
});

test("derives the only archive authorization from a complete exact extraction", () => {
  const decision=deriveInvoiceRuleDecision(validateInvoiceExtraction(clearExtraction()));
  assert.deepEqual(decision,{
    action:"archive_dining",
    reasonCode:"eligible",
    invoice:clearExtraction().invoice
  });
});

test("derives exact buyer mismatch outcomes without archive authorization", () => {
  assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
    invoice:{buyer_name:"其他测试公司"}
  })),"buyer_name_mismatch");
  assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
    invoice:{buyer_tax_id:"OTHER"}
  })),"buyer_tax_id_mismatch");
  assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
    invoice:{buyer_name:"其他测试公司",buyer_tax_id:"OTHER"}
  })),"buyer_identity_mismatch");
});

test("maps every missing or unclear required field to clarification", () => {
  for (const field of FIELDS) {
    assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
      invoice:{[field]:""},
      field_quality:{[field]:"missing"}
    })),"required_field_missing");
    assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
      invoice:{[field]:""},
      field_quality:{[field]:"unclear"}
    })),"required_field_unclear");
  }
});

test("maps document and category states to fixed non-writing decisions", () => {
  assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
    document_verification:"multiple_invoices"
  })),"multiple_invoices");
  assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
    document_verification:"conflicting_fields"
  })),"conflicting_fields");
  assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
    document_verification:"unclear"
  })),"document_unclear");
  assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
    category:"non_dining"
  })),"non_dining");
  assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
    category:"uncertain"
  })),"category_uncertain");
});

test("preserves raw extracted values and applies existing archive format gates in Node", () => {
  assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
    invoice:{invoice_number:"TEST-20260724-001"}
  })),"invoice_number_invalid");
  assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
    invoice:{issue_date:"2026年07月24日"}
  })),"issue_date_invalid");
  assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
    invoice:{issue_date:"2026-02-30"}
  })),"issue_date_invalid");
  assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
    invoice:{total_with_tax:"¥290.00"}
  })),"total_invalid");
  assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
    invoice:{total_with_tax:"0.00"}
  })),"total_invalid");
});

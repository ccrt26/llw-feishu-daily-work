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
const REQUIRED_FIELDS=["issue_date","buyer_name","buyer_tax_id","total_with_tax"];
const NON_GATING_FIELDS=["invoice_number","seller_name","item_name"];

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

test("maps every missing or unclear eligibility and storage field to clarification", () => {
  for (const field of REQUIRED_FIELDS) {
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

test("invoice number, seller and item extraction quality do not add archive gates", () => {
  for (const field of NON_GATING_FIELDS) {
    for (const quality of ["missing","unclear"]) {
      const decision=deriveInvoiceRuleDecision(clearExtraction({
        invoice:{[field]:""},
        field_quality:{[field]:quality}
      }));
      assert.equal(decision.action,"archive_dining");
      assert.equal(decision.reasonCode,"eligible");
    }
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

test("normalizes the two approved date forms without mutating raw extraction", () => {
  const chinese=clearExtraction({invoice:{issue_date:"2026年07月21日"}});
  const chineseDecision=deriveInvoiceRuleDecision(chinese);
  assert.equal(chineseDecision.action,"archive_dining");
  assert.equal(chineseDecision.reasonCode,"eligible");
  assert.equal(chineseDecision.invoice.issue_date,"2026-07-21");
  assert.equal(chinese.invoice.issue_date,"2026年07月21日");

  const iso=clearExtraction({invoice:{issue_date:"2026-07-21"}});
  const isoDecision=deriveInvoiceRuleDecision(iso);
  assert.equal(isoDecision.action,"archive_dining");
  assert.equal(isoDecision.invoice.issue_date,"2026-07-21");
  assert.equal(iso.invoice.issue_date,"2026-07-21");
});

test("normalizes safe storage displays and rejects ambiguous date or amount values", () => {
  for (const [issue_date,total_with_tax,expectedDate,expectedAmount] of [
    ["2026/07/21","¥290.00","2026-07-21","290.00"],
    ["2026年7月21日","￥290元","2026-07-21","290.00"],
    [" 2026-07-21 ","1,290.5","2026-07-21","1290.50"]
  ]) {
    const decision=deriveInvoiceRuleDecision(clearExtraction({
      invoice:{issue_date,total_with_tax}
    }));
    assert.equal(decision.action,"archive_dining");
    assert.equal(decision.invoice.issue_date,expectedDate);
    assert.equal(decision.invoice.total_with_tax,expectedAmount);
  }
  for (const issue_date of [
    "26-07-21",
    "2026年7月",
    "2026-02-30",
    "2026年02月30日"
  ]) {
    assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
      invoice:{issue_date}
    })),"issue_date_invalid");
  }
  for (const total_with_tax of ["0.00","-290.00","1,29.00","2.9e2"]) {
    assertNoArchive(deriveInvoiceRuleDecision(clearExtraction({
      invoice:{total_with_tax}
    })),"total_invalid");
  }
});

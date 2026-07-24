export function formatUnsupported(kind) {
  if (kind === "ofd") return outcome("rejected","已安全下载并识别为 OFD，但当前版本尚未启用 OFD 转换与票面核验，因此未交给 AI、未归档。请暂时发送清晰的 JPG、JPEG、PNG 或 WebP 图片。");
  return outcome("rejected","不支持此附件格式，未交给 AI、未归档。当前支持 PDF、JPG、JPEG、PNG 和 WebP 发票文件。");
}

export function formatNonArchive(decision) {
  const rejected={
    buyer_name_mismatch:"购买方名称与指定归档主体不匹配。",
    buyer_tax_id_mismatch:"购买方统一社会信用代码/纳税人识别号与指定归档主体不匹配。",
    buyer_identity_mismatch:"购买方名称和统一社会信用代码/纳税人识别号均与指定归档主体不匹配。",
    non_dining:"票面项目不属于当前已启用的餐饮发票类别。"
  };
  const clarification={
    required_field_missing:["必填字段缺失。","请发送包含全部必要票面元素的完整发票原件。"],
    required_field_unclear:["必填字段无法清晰读取。","请重新发送所有必要票面元素均清晰可见的完整发票原件。"],
    category_uncertain:["无法可靠确认票面项目是否属于餐饮类别。","请发送项目名称清晰可见的完整发票原件。"],
    multiple_invoices:["检测到一份 PDF 可能包含多张发票。","请拆分为一张发票一个 PDF 后重新发送。"],
    conflicting_fields:["不同页面关键字段冲突。","请核对并发送正确的原始 PDF。"],
    document_unclear:["无法确认整份文件只含一张完整发票。","请发送更清晰、完整的原始发票文件。"],
    invoice_number_invalid:["发票号码格式不符合当前归档规则。","请核对并发送号码清晰、完整的发票原件。"],
    issue_date_invalid:["开票日期格式或日期值不符合当前归档规则。","请核对并发送开票日期清晰、完整的发票原件。"],
    total_invalid:["价税合计格式或金额值不符合当前归档规则。","请核对并发送价税合计清晰、完整的发票原件。"]
  };
  if (decision?.action==="reject"&&Object.hasOwn(rejected,decision.reasonCode)) {
    return outcome("rejected",`发票未归档：未通过入库核验。\n原因：${rejected[decision.reasonCode]}`);
  }
  if (decision?.action==="needs_clarification"&&Object.hasOwn(clarification,decision.reasonCode)) {
    const [reason,question]=clarification[decision.reasonCode];
    return outcome("awaiting_clarification",`发票未归档：需要确认。\n原因：${reason}\n问题：${question}`);
  }
  throw new Error("invalid_invoice_rule_decision");
}

export function formatArchive(decision,archived) {
  if (archived.status === "awaiting_clarification") return outcome("awaiting_clarification","发票未归档：需要确认。\n原因：已存在同金额、同发票号码但内容不同的文件。\n问题：请人工核对现有文件与本次附件；系统不会覆盖任何文件。");
  if (!["committed","existing"].includes(archived.status) || !archived.relativePath) return failure("archive_failed");
  const heading=archived.status === "existing" ? "发票已归档（文件已存在，未重复复制）" : "发票已归档";
  return outcome(archived.status,[heading,"类别：餐饮发票",`开票日期：${decision.invoice.issue_date}`,`含税金额：${decision.invoice.total_with_tax} 元`,`位置：${archived.relativePath}`].join("\n"),[archived.relativePath]);
}

export function failure(stage,code) {
  if (stage === "prepare_pdf") {
    const prepared={
      pdf_encrypted:["rejected","PDF 已下载，但文件受密码或加密保护，无法安全读取，未归档。请发送未加密的原始 PDF。"],
      pdf_page_limit:["rejected","PDF 已下载，但超出本能力单份 10 页上限，未交给 AI、未归档。请发送一张发票一个 PDF 的原件。"],
      pdf_structure_invalid:["failed","发票处理失败，文件未归档。\n原因：PDF 结构无法安全解析，请重新导出或重新发送原始 PDF。"],
      pdf_prepare_timeout:["failed","发票处理失败，文件未归档。\n原因：PDF 页面处理超时，请稍后重试或重新导出原始 PDF。"]
    }[code];
    if (prepared) return outcome(prepared[0],prepared[1]);
    return outcome("failed","发票处理失败，文件未归档。\n原因：PDF 页面无法完整呈现，未交给 AI、未归档；请重新导出原始 PDF。");
  }
  const detail={
    download:"附件下载失败，请重新发送原附件。",
    inspect:"附件安全检查失败，请重新发送受支持的原始发票文件。",
    analyze:"AI 暂时不可用或识别结果无效，请稍后重试或发送更清晰、完整的发票原件。",
    archive:"U 盘不可用或复制校验失败；系统没有覆盖现有文件。",
    archive_failed:"归档结果不明确；系统没有覆盖现有文件。"
  }[stage] || "发生受控错误，请稍后重试。";
  return outcome("failed",`发票处理失败，文件未归档。\n原因：${detail}`);
}

function outcome(status,reply,artifacts=[]) { return {status,reply,artifacts}; }

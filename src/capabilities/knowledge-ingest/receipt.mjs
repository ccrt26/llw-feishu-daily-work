const REJECTED={
  save_intent_missing:"本次未写入：没有检测到明确的知识入库要求。",
  unsupported_format:"本次未写入：当前版本只支持直接文字、TXT、Markdown、DOCX、PPTX、XLSX 和受支持的飞书文档快照。",
  source_unreadable:"本次未写入：来源无法安全读取，请重新发送完整原件。",
  source_incomplete:"本次未写入：来源内容不完整，请重新发送完整原件。",
  multiple_sources:"本次未写入：每次只处理一个来源，请分开发送。",
  existing_change_forbidden:"本次未写入：知识入库能力不修改、覆盖、合并或删除已有资料。",
  unsafe_instruction:"本次未写入：请求包含超出知识入库边界的操作。",
  folder_operation_forbidden:"本次未创建目录：不支持移动、重命名、合并、删除或批量整理。",
  unsafe_folder_plan:"本次未创建目录：目录计划未通过安全校验。"
};

export function formatKnowledgeCommit(decision,result,library) {
  validateLibrary(library);
  validateWriterResult(result,{item:true});
  const heading=result.status==="created"
    ?"知识资料已入库。"
    :"知识资料已存在，未重复写入。";
  return outcome(
    result.status==="created"?"committed":"existing",
    [
      heading,
      `标题：${safeInline(decision.title)}`,
      `资料库：${library.displayName}`,
      `位置：${result.relativePath}`
    ].join("\n"),
    result.files
  );
}

export function formatKnowledgeFolder(result,library) {
  validateLibrary(library);
  validateWriterResult(result,{item:false});
  const heading=result.status==="created"?"目录已创建。":"目录已存在，未重复创建。";
  return outcome(
    result.status==="created"?"committed":"existing",
    [
      heading,
      `资料库：${library.displayName}`,
      `位置：${result.relativePath}`,
      "规则：仅创建空目录，不移动、重命名、覆盖或删除已有内容。"
    ].join("\n"),
    [result.relativePath]
  );
}

export function formatKnowledgeQuestion(decision,library,libraries) {
  if (decision.reasonCode==="folder_confirmation_required") {
    validateLibrary(library);
    const segments=decision.target.segments;
    if (!Array.isArray(segments)||!segments.length) throw new Error("invalid_knowledge_receipt");
    return outcome("awaiting_clarification",[
      "需要确认后才能创建新目录。",
      `资料库：${library.displayName}`,
      `拟创建目录：${segments.map(safeInline).join("/")}`,
      "规则：仅在该受管资料库下创建空目录；不移动、重命名、覆盖或删除已有内容。",
      "问题：是否确认按以上规则创建？"
    ].join("\n"));
  }
  if (decision.reasonCode==="library_required") {
    if (!Array.isArray(libraries)||!libraries.length) throw new Error("invalid_knowledge_receipt");
    return outcome(
      "awaiting_clarification",
      `请选择要保存的资料库：${libraries.map(item=>{
        validateLibrary(item); return item.displayName;
      }).join("、")}。确认后本次才会继续，不会提前写入。`
    );
  }
  return outcome(
    "awaiting_clarification",
    "还需要你确认入库目标或命名规则；确认前不会创建目录或写入知识库。"
  );
}

export function formatKnowledgePending() {
  return outcome(
    "awaiting_attachment",
    "已记住本次入库要求，请在 24 小时内发送一份 TXT、Markdown、DOCX、PPTX 或 XLSX 文件。\n文件到达前不会创建目录或写入知识库。"
  );
}

export function formatKnowledgeAttachmentNeedsRequest() {
  return outcome(
    "rejected",
    "请先用文字说明这份资料要保存到哪个资料库或现有目录，再发送一份 TXT、Markdown、DOCX、PPTX 或 XLSX 文件；本次附件未下载、未写入。"
  );
}

export function formatKnowledgeExtractionPartial(limitations) {
  const labels={
    embedded_media_not_extracted:"图片或嵌入媒体",
    charts_not_extracted:"图表",
    annotations_not_extracted:"批注或注释",
    headers_or_footers_not_extracted:"页眉或页脚",
    speaker_notes_not_extracted:"演讲者备注",
    drawings_not_extracted:"绘图对象",
    pivot_tables_not_extracted:"数据透视表"
  };
  const parts=Array.isArray(limitations)
    ?limitations.map(item=>labels[item]).filter(Boolean):[];
  const detail=parts.length?`未完整读取：${[...new Set(parts)].join("、")}。`:
    "存在无法完整读取的文档内容。";
  return outcome(
    "rejected",
    `${detail}\n为避免把不完整理解写入知识库，本次未调用 AI、未创建目录、未写入；请提供不依赖这些内容的完整版本。`
  );
}

export function formatKnowledgeReject(reasonCode) {
  return outcome("rejected",REJECTED[reasonCode]||
    "本次未写入：请求不符合当前知识入库规则。");
}

export function formatKnowledgeFailure() {
  return outcome(
    "failed",
    "知识资料处理失败，本次未写入或创建目录；请稍后重试。"
  );
}

export function formatKnowledgeCodexOnly() {
  return outcome(
    "rejected",
    "知识资料入库当前仅支持 Codex。本次未调用模型、未创建目录、未写入知识库；请切换到 Codex 后重试。"
  );
}

function validateWriterResult(result,{item}) {
  if (!result||!new Set(["created","existing"]).has(result.status)||
      !safeRelative(result.relativePath)) {
    throw new Error("invalid_knowledge_receipt");
  }
  if (item) {
    if (!Array.isArray(result.files)||!result.files.length||
        result.files.some(file=>!safeRelative(file))) {
      throw new Error("invalid_knowledge_receipt");
    }
  }
}

function validateLibrary(library) {
  if (!library||!/^[a-z][a-z0-9_-]{0,63}$/u.test(library.libraryKey||"")||
      typeof library.displayName!=="string"||!library.displayName||
      /[\r\n\u0000]/u.test(library.displayName)) {
    throw new Error("invalid_knowledge_receipt");
  }
}

function safeRelative(value) {
  return typeof value==="string"&&value&&!value.startsWith("/")&&
    !value.startsWith("\\")&&!/[\r\n\u0000]/u.test(value)&&
    value.split("/").every(segment=>segment&&segment!=="."&&segment!=="..");
}

function safeInline(value) {
  if (typeof value!=="string"||!value.trim()) throw new Error("invalid_knowledge_receipt");
  return value.normalize("NFC").replace(/[\r\n\t]+/gu," ").trim();
}

function outcome(status,reply,artifacts=[]) {
  return {status,reply,artifacts:[...artifacts]};
}

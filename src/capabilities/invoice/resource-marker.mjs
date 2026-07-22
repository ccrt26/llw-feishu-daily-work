export function parseInvoiceResource(message) {
  if (!Array.isArray(message?.attachments)||message.attachments.length!==1) throw coded("unsupported_resource_type");
  const attachment=message.attachments[0];
  if (attachment?.type==="image") {
    if (!/^img_[A-Za-z0-9_-]+$/.test(attachment.sourceAttachmentId)) throw coded("invalid_resource_marker");
    return {fileKey:attachment.sourceAttachmentId,type:"image"};
  }
  if (attachment?.type==="file") {
    if (!/^file_[A-Za-z0-9_-]+$/.test(attachment.sourceAttachmentId)) throw coded("invalid_resource_marker");
    return {fileKey:attachment.sourceAttachmentId,type:"file"};
  }
  throw coded("unsupported_resource_type");
}

function coded(code) {
  return Object.assign(new Error(code), {code});
}

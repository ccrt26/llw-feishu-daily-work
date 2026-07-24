# 微信门 B 二维码接口 `content-type` 不一致问题报告

> 用途：供项目所有者与 ChatGPT 讨论下一步处理方案。
> 记录日期：2026-07-24（Asia/Shanghai）
> 状态：`blocked_pending_owner_decision`
> 安全结论：没有记录二维码、token、微信用户/机器人标识、响应字段值或消息正文。

## 1. 一句话结论

阶段四门 A 已完成，生产代码已部署但微信保持关闭。进入门 B 获取真实二维码时，腾讯接口返回了 HTTP `200`，响应体也是预期结构的合法 JSON，但 HTTP 响应头把它标成了 `application/octet-stream`。

当前客户端按照 V3.2 既定安全边界，只接受 JSON `content-type`，所以在读取二维码值之前主动失败为：

```text
wechat_response_not_json
```

这不是模型、飞书、钥匙串、二维码扫码、配置或网络连通性问题，而是“官方文档描述的响应媒体类型”和“真实接口返回的响应媒体类型”不一致。V3.2 规定协议边界变化必须停止并单独取得项目所有者批准，因此当前没有直接修改代码。

## 2. 当前生产状态

截至本报告生成时：

| 项目 | 当前事实 |
| --- | --- |
| 生产组件提交 | `40518cc` |
| 生产分支 | `production/v32-phase4-wechat` |
| 完整回归 | `270/270` PASS |
| 微信开关 | `wechatEnabled=false` |
| 当前模型 | Codex |
| 飞书 | 一个 Node 主进程、一个直属 lark-cli 消费者，心跳正常 |
| 门 A 真实飞书验收 | 通过，只新增一个 `daily-work/committed` outcome |
| 微信状态文件 | 不存在 |
| 微信 token | 未生成、未保存 |
| 微信 Keychain 写入 | 未执行 |
| 微信扫码 | 未发生，二维码尚未显示 |
| 正式 Vault 微信验收 | 未执行 |

受保护回滚点已经完成并验证：

```text
~/Library/Application Support/LLW Assistant/backups/baselines/
  v3-phase-4-pre-deploy-2026-07-24/
```

回滚点目录为 `0700`、工件为 `0600`，manifest、两个 Git bundle、三个 Skill 和 `/private/tmp` 恢复演练均已通过。

## 3. 预期行为

固定协议证据来自：

```text
Tencent/openclaw-weixin@cef0bfc390393f716903e16d50408118047f87e0
```

腾讯当前中文 README 也仍把后端描述为 HTTP JSON API，并说明扫码后在手机上确认授权，凭据自动保存，无需额外添加步骤：

- [腾讯 README：扫码登录](https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md#3-扫码登录)
- [腾讯 README：后端 API 协议](https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md#后端-api-协议)
- [项目固定审阅提交](https://github.com/Tencent/openclaw-weixin/tree/cef0bfc390393f716903e16d50408118047f87e0)

客户端因此固定了以下顺序：

1. HTTPS 请求必须成功。
2. 禁止自动跟随重定向。
3. JSON 接口的 `content-type` 必须是：
   - `application/json`；或
   - `application/*+json`。
4. 响应体最大 1 MiB。
5. 响应体必须是合法 JSON。
6. 每个操作继续执行自己的字段和 Schema 校验。
7. 只有二维码确认成功后才允许写 Keychain 和无 token 状态。

## 4. 实际发生了什么

### 4.1 第一次真实绑定

执行生产组件的手工绑定入口后，进程在显示二维码前立即返回：

```text
bind_ok=false
```

CLI 的正常安全行为是不打印内部异常、响应正文或平台值，所以随后只运行了输出固定错误码的诊断入口，得到：

```text
bind_error_code=wechat_response_not_json
```

### 4.2 HTTP 方法排查

对同一个腾讯固定二维码端点，仅检查状态码、响应媒体类型和是否重定向，不读取或输出正文：

| 请求 | HTTP 状态 | `content-type` | 重定向 |
| --- | ---: | --- | --- |
| POST | `200` | `application/octet-stream` | 否 |
| GET | `200` | `application/octet-stream` | 否 |

因此问题不是简单的 POST/GET 方法选择错误；两种方法都返回同一种媒体类型。

### 4.3 受限内存解析

为区分“真正的二进制协议”与“错误标注的 JSON”，又执行了一次严格受限诊断：

- 只使用 POST；
- 响应最大仍为 1 MiB；
- 不写磁盘；
- 不打印正文；
- 不打印任何字段值；
- 只判断能否解析 JSON，并输出字段名和字段类型。

结果：

```text
HTTP status=200
content-type=application/octet-stream
body_bytes=167
body_json_valid=true
top_level_keys=qrcode,qrcode_img_content,ret
qrcode_type=string
qrcode_img_content_type=string
ret_type=number
```

这证明当前真实响应不是任意二进制文件，而是被标注为 `application/octet-stream` 的 JSON。所有字段值在诊断进程结束后即丢弃，没有保存或展示。

## 5. 精确代码触发点

当前生产提交 `40518cc` 中：

### 5.1 绑定流程

文件：

```text
src/wechat-bind.mjs
```

关键顺序：

- 第 27–29 行：创建 API 客户端并调用 `getQrCode()`；
- 第 30 行：只有 `getQrCode()` 成功后才打开二维码；
- 第 33–49 行：二维码轮询与确认；
- 第 50–52 行：确认 token、机器人标识、扫码者标识和服务地址；
- 第 54–62 行：此时才写 Keychain；
- 第 64–72 行：最后才写无 token 的 `0600` 状态。

本次失败发生在第 29 行内部，因此没有到达打开二维码、轮询、Keychain 或状态写入。

### 5.2 JSON 响应门禁

文件：

```text
src/adapters/wechat-api.mjs
```

关键逻辑位于第 102–109 行：

```js
const contentType=response.headers.get("content-type")?.toLowerCase()||"";
if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/.test(contentType)) {
  throw new Error("wechat_response_not_json");
}
```

客户端在读取响应体之前先检查媒体类型。因此，即使真实响应体是合法 JSON，只要响应头为 `application/octet-stream`，仍会按既定边界拒绝。

### 5.3 现有测试假设

文件：

```text
test/wechat-api.test.mjs
```

- 现有 JSON fixture 固定使用 `application/json`；
- 现有失败测试要求 `text/plain` 被拒绝；
- 现有超限测试要求 JSON 超过 1 MiB 被拒绝；
- 媒体下载路径单独允许 `application/octet-stream`，但它是加密图片/PDF的二进制下载，不是 JSON控制接口。

当前测试尚未覆盖“控制接口返回 `application/octet-stream`，但响应体是严格合法 JSON”的真实情况。

## 6. 已排除的原因

### 6.1 不是大模型问题

绑定失败发生在任何 Router、Codex、DeepSeek 或业务 Skill 运行之前。没有调用模型。

### 6.2 不是 Keychain 问题

Keychain 写入只发生在二维码确认成功之后。本次连二维码都没有显示，代码路径没有到达 Keychain。

### 6.3 不是配置版本问题

生产配置已经由当前 version 4 Schema 正常加载：

```text
wechatEnabled=false
effective_model=codex
```

若配置不合法，错误会在发起二维码请求之前成为 `wechat_binding_invalid`，而本次固定错误码是 `wechat_response_not_json`。

### 6.4 不是网络完全不通

真实端点对 GET 和 POST 都返回 HTTP `200`，没有重定向，且响应体可以完整读取。

### 6.5 不是二维码过期或扫码失败

二维码值尚未进入打开浏览器的代码路径，用户没有机会扫码。

### 6.6 不是普通 HTTP 方法错误

GET 与 POST 的状态和媒体类型相同。当前证据不能证明切换方法可以解决问题。

## 7. 为什么客户端当前拒绝是合理的

`content-type` 检查原本用于防止以下风险：

- HTML 登录页、WAF 页面或代理错误页被当成 JSON；
- 非预期二进制内容进入 JSON 解析；
- 服务端协议漂移被静默吞掉；
- 错误正文、token 或平台值进入异常和日志；
- 对所有外部接口做危险的“只要能解析就接受”。

所以这次失败说明安全门按设计工作，并不说明代码质量有问题。真正需要决定的是：是否为腾讯当前这种“JSON正文 + octet-stream 响应头”增加一个足够窄、可测试、可回滚的兼容边界。

## 8. 尚未知道的事实

当前只真实检查了获取二维码接口。以下接口尚未真实调用，因此不知道是否也返回 `application/octet-stream`：

- 二维码状态轮询；
- `getupdates` 长轮询；
- `sendmessage` 回复；
- 重定向后的服务主机；
- 鉴权过期响应；
- 错误响应。

还没有验证：

- 手机确认页面是否包含额外条款、验证码或“添加/启用机器人”；
- 扫码确认结果是否适用于当前账号和地区；
- 真实文字、图片、PDF和原会话回复；
- 断线、重启与同步游标恢复。

不能把二维码接口的观察结果直接推广成“所有接口都一定如此”。

## 9. 可讨论的处理选项

### 方案 A：保持阻断，不再推进

保持：

```text
wechatEnabled=false
```

不修改客户端，不再扫码。

优点：

- 完全保留原安全边界；
- 没有新增协议假设；
- 飞书和阶段三/门 A 状态继续稳定。

代价：

- 普通微信第二入口无法启用；
- 阶段四停在门 B。

### 方案 B：增加“端点级、严格 JSON”的最小兼容

候选原则：

1. 继续接受现有 JSON媒体类型。
2. 只对既定 iLink 控制接口考虑兼容 `application/octet-stream`。
3. `application/octet-stream` 不等于自动接受：
   - 仍先执行状态码、HTTPS、主机、端口、重定向和超时校验；
   - 仍限制 JSON正文最大 1 MiB；
   - 必须完整解析为 JSON；
   - 必须通过该操作的精确字段和 Schema 校验；
   - 非 JSON、畸形 JSON、超限、未知字段/状态仍失败关闭；
   - 错误只返回固定错误码，不输出正文。
4. 媒体下载继续使用独立的 20 MiB 二进制边界，不能与 JSON兼容逻辑混在一起。
5. 不扩大到任意第三方主机或通用 `fetch`。

优点：

- 与真实腾讯响应兼容；
- 可以保留字节上限、严格 JSON和 Schema；
- 修改面理论上只涉及一个适配器和对应测试。

风险：

- `content-type` 不再能单独作为控制接口的第一道拒绝条件；
- 若范围写得过宽，可能把真正的二进制错误响应交给 JSON解析；
- 当前只观察到二维码接口，是否推广到轮询/更新/回复接口需要设计判断。

### 方案 C：只为二维码接口兼容，其他接口逐个验证

只允许二维码获取接口接受 `application/octet-stream`，扫码后若状态轮询或其他接口再次出现同类差异，再停止。

优点：

- 范围最窄；
- 每个接口都以真实证据为前提。

风险：

- 可能在扫码后的多个阶段重复停止和修改；
- token/状态写入的事务边界更难管理；
- 容易形成多个分散的特殊分支。

### 方案 D：只要正文能解析 JSON 就接受

忽略响应媒体类型，对所有 JSON请求直接尝试解析正文。

不建议，原因：

- 范围过宽；
- 会弱化 HTML/WAF/代理错误页的显式识别；
- 不符合 V3.2 的最小边界原则。

### 方案 E：改用 OpenClaw/第三方 SDK

不在当前授权范围内，也违反 V3.2 阶段四的固定架构：

- 不安装 OpenClaw；
- 不安装腾讯插件；
- 不新增第三方 SDK 或 npm 运行依赖；
- 不改变单进程薄入口设计。

除非项目所有者修改总体基线，否则不应作为本问题的临时绕行方案。

## 10. 如果选择最小兼容，建议的工程门禁

以下内容是供讨论的候选验收标准，不代表已经批准实施。

### 10.1 先写失败测试

至少覆盖：

1. 精确控制端点返回 `application/octet-stream` + 合法 JSON + 正确 Schema：按批准范围决定允许。
2. `application/octet-stream` + 非 JSON：拒绝为固定错误码。
3. `application/octet-stream` + 超过 1 MiB：拒绝。
4. `application/octet-stream` + JSON数组或错误顶层类型：拒绝。
5. `application/octet-stream` + 缺字段/错字段类型：拒绝。
6. `text/html`、`text/plain`：继续拒绝。
7. HTTP非 2xx：继续在读取正文前拒绝。
8. 重定向：继续拒绝。
9. 错误中不得出现测试 token 或响应正文。
10. 媒体下载的 `application/octet-stream` 行为不变。

### 10.2 最小修改范围

候选只涉及：

```text
src/adapters/wechat-api.mjs
test/wechat-api.test.mjs
```

不应修改：

- Router；
- daily-work/invoice；
- 三个 Skill；
- StateStore版本；
- LaunchAgent；
- 飞书权限和入口；
- 正式 Vault；
- DeepSeek/Codex模型逻辑；
- npm 依赖。

### 10.3 验证顺序

1. RED：新增真实差异 fixture，确认当前代码失败。
2. GREEN：实现批准范围内的最小兼容。
3. 定向测试全部通过。
4. 完整回归必须 `0 fail`，记录新的精确总数。
5. 生产仍保持 `wechatEnabled=false`。
6. 部署修复后再次确认飞书、Codex、单消费者和 heartbeat。
7. 再重新执行二维码绑定。
8. 若后续接口出现新的未批准协议差异，再次停止。

## 11. 希望 ChatGPT重点回答的问题

请 ChatGPT 基于以上证据逐项给出明确结论：

1. 在 HTTPS、精确端点、1 MiB上限、严格 JSON解析和操作级 Schema都保留的前提下，兼容 `application/octet-stream` 是否仍属于合理安全边界？
2. 兼容范围应选择：
   - 仅二维码获取；
   - 二维码获取与状态轮询；
   - 所有现有 iLink JSON控制接口；
   - 其他更窄的端点白名单？
3. `content-type` 不匹配时，应该先读取受限字节再解析，还是继续完全拒绝？
4. 是否需要为响应增加比当前更严格的操作级 Schema，作为放宽媒体类型后的补偿控制？
5. `ret`、未知字段、未知状态和重定向主机应如何验证，才能避免协议漂移被静默接受？
6. 二维码、状态轮询、`getupdates`、`sendmessage` 是否应该分别有独立的响应媒体类型策略？
7. 当前证据是否足以修改，还是应该先通过其他只读方式确认腾讯服务端的真实约定？
8. 如果同意修改，请给出最小伪代码、测试清单和明确的“不得扩大”边界。
9. 如果不同意修改，请说明应当停在阶段四门 B，还是有不违反 V3.2 的替代验证方法。

## 12. 需要 ChatGPT避免的误判

- 不要把问题归因于 Codex 或 DeepSeek；模型尚未运行。
- 不要建议先删除 `content-type` 校验再试。
- 不要把媒体二进制下载和控制接口 JSON混为一谈。
- 不要建议把 token 写进配置、环境变量、工作区或日志。
- 不要建议安装 OpenClaw、插件或通用微信 SDK作为临时修复。
- 不要假设扫码已经完成或机器人已经添加。
- 不要把当前 `application/octet-stream` 观察自动推广到所有接口。
- 不要建议未经测试直接修改生产。

## 13. 当前决策门

在项目所有者和 ChatGPT讨论完成前，固定保持：

```text
wechatEnabled=false
effective_model=codex
feishu_healthy=true
wechat_keychain_write=false
wechat_state_file=false
formal_vault_wechat_test=false
```

只有项目所有者明确批准某个兼容边界后，才允许按 RED → GREEN → 完整回归 → 关闭状态部署 → 再次扫码的顺序继续。

# 首期 API 与数据契约基线

> 状态：评审草案。路径为建议契约，正式实现前生成 OpenAPI 并确认认证、字段、错误码和微信支付商户方案。

## 1. 通用契约

- 前缀 `/api/v1`；JSON；所有时间为 ISO 8601 UTC；金额为整数分，禁止浮点数。
- 用户会话与后台会话隔离；服务端校验身份、资源归属、角色、状态和数据范围。
- 创建/支付/接单/签到签退/退款命令接受 `Idempotency-Key`；同键同主体同请求返回同结果，不同请求体冲突返回 `409`。
- 响应包含 `requestId`；错误统一为 `{code, message, requestId, details?}`，不泄露敏感数据。
- 乐观并发使用 `version` 或 `If-Match`；过期版本返回 `409 STATE_CONFLICT`。

## 2. 用户与订单 API

| 方法 | 路径 | 权限/约束 |
| --- | --- | --- |
| `POST` | `/auth/wechat-login` | 校验微信登录凭证，服务端建立会话 |
| `GET/POST` | `/pets` | 当前用户；字段最小化 |
| `GET/PATCH/DELETE` | `/pets/{petId}` | 必须校验所有权 |
| `GET/POST` | `/addresses` | 当前用户；入户凭证不随地址普通字段返回 |
| `POST` | `/orders/quotes` | 服务端计算价格，返回 `quoteId`、金额、明细、有效期和规则版本 |
| `POST` | `/orders` | 幂等；传 `quoteId`、宠物/地址 ID、时段及必要选项；返回订单和支付截止时间 |
| `GET` | `/orders` | 仅本人；游标分页 |
| `GET` | `/orders/{orderId}` | 本人或经授权岗位/有效分配喂养师，字段按角色过滤 |
| `POST` | `/orders/{orderId}/cancel-requests` | 按状态及取消政策计算可退金额 |
| `POST` | `/orders/{orderId}/reschedule-requests` | 时段容量原子校验；保留请求记录 |
| `POST` | `/orders/{orderId}/completion-confirmations` | 仅用户本人且待确认 |
| `POST` | `/orders/{orderId}/reviews` | 本人已完成订单；一单一条有效评价，重试幂等 |
| `POST` | `/orders/{orderId}/after-sales` | 仅订单相关主体，幂等创建工单 |

## 3. 履约、后台与资金 API

| 方法 | 路径 | 权限/约束 |
| --- | --- | --- |
| `GET` | `/sitter/orders` | 只返回分配给当前喂养师且允许查看的字段 |
| `POST` | `/sitter/orders/{id}/acceptances` | 条件状态迁移并检查当前喂养师日程冲突 |
| `POST` | `/sitter/orders/{id}/declines` | 仅本人待接受派单，拒绝需原因 |
| `POST` | `/sitter/orders/{id}/check-ins` | 幂等，服务端校验时窗和履约状态 |
| `POST` | `/sitter/orders/{id}/check-outs` | 幂等，校验签到及必做清单，撤销入户授权 |
| `POST` | `/sitter/orders/{id}/service-logs` | 结构化必做清单；保存追加版本 |
| `POST` | `/sitter/orders/{id}/media-upload-sessions` | 返回短时私有上传授权；完成后服务端确认元数据 |
| `POST` | `/orders/{orderId}/prepayments` | 仅本人未过期订单；复用在途支付单或安全关闭后再创建；返回官方支付参数 |
| `GET` | `/payments/{paymentId}/status` | 仅本人或授权财务；查询渠道事实，不信任客户端结果 |
| `POST` | `/webhooks/wechat-pay` | 验签、解密、商户/金额/订单校验、幂等；不使用用户会话 |
| `POST` | `/webhooks/wechat-refund` | 渠道退款通知，验签/解密、核对原支付单与金额、幂等 |
| `POST` | `/admin/orders/{id}/assignments` | 运营权限、原因必填、事务防双派 |
| `POST` | `/admin/orders/{id}/reassignments` | 运营权限、日程冲突校验、旧授权撤销及审计 |
| `POST` | `/admin/orders/{id}/refunds` | 退款申请与审批权限分离；服务端计算金额 |
| `POST` | `/admin/refunds/{refundId}/approvals` | 独立审批权限；申请人不可自批，审批后由持久化任务发起渠道退款 |
| `POST` | `/admin/after-sales/{id}/resolutions` | 记录证据引用、结论、责任人和用户通知 |
| `GET` | `/admin/reconciliation/differences` | 财务范围；导出需审计 |

## 4. 核心数据约束

| 实体 | 关键约束 |
| --- | --- |
| `orders` | 外部订单号唯一；金额/规则/服务快照不可被配置更新覆盖；含 `version`、`payment_deadline`、预约窗口 |
| `slot_reservations` | 区域/服务/时段/订单/到期时间/状态；跨时段整体扣减和释放；订单与时段组合唯一 |
| `sitter_schedule_reservations` | 喂养师/起止时间/交通缓冲/派单记录；事务内串行化校验区间重叠，跨区域统一约束 |
| `order_assignments` | 追加保存派单历史；同一订单最多一个有效 assignment |
| `order_events` | 追加式状态日志；记录主体、来源、原因、请求 ID、前后状态和时间 |
| `payments` | 商户单号唯一；渠道交易号唯一；金额币种不可变；支付状态来源可追溯 |
| `refunds` | 退款单号及渠道退款号唯一；成功及在途/未知退款共同占用可退额度，不得并发超退；未知结果先查渠道 |
| `ledger_entries` | 追加式、不可更新删除；资金方向、金额、币种、来源业务及冲正引用明确 |
| `settlement_items` | 订单来源唯一；区分应结/审批/支付中/实付；结算冻结关联售后 |
| `media_assets` | 私有对象键、大小/格式校验、订单授权、保留期限、上传确认状态 |
| `idempotency_records` | 主体 + 操作 + key 唯一；存请求摘要、结果摘要、过期策略 |
| `audit_logs` | 操作者、动作、对象、理由、时间、requestId；不存凭证明文和不必要 PII |

## 5. 事件与一致性

支付回调、用户命令和后台操作在一个数据库事务中更新业务状态、状态事件和 outbox；异步消费者处理通知、影像清理及对账任务，采用至少一次投递 + 幂等消费。支付结果不确定时主动查渠道，不能因前端超时判定失败。迁移需包含回滚/前滚策略；敏感信息密钥使用托管密钥管理，测试环境使用脱敏数据。

## 6. 契约边界与上线前门槛

本文优先描述交易纵向切片，尚非完整接口清单。微信手机号绑定、喂养师申请/审核/排班、服务目录与区域、报价输入字段、地址修改、凭证授权、上传确认/读取、售后明细、隐私请求、后台认证及结算审批/实付等接口仍需在对应模块开发前补齐 OpenAPI。与原方案中的示例路径不同的命名，在联调前统一冻结，不要求客户端同时兼容多套草案。

- OpenAPI 对所有端点列出认证、角色、数据范围、请求/响应、错误码、幂等和限流策略。
- 支付回调按实际微信支付版本完成验签、解密、证书轮换及沙箱/联调验证。
- 数据库迁移通过重复请求、并发容量、双接单、支付延迟/重放、退款失败测试。
- 明确字段保留期限、删除/匿名化行为、备份加密、审计查看权限和恢复演练。
- 任何未核验的支付、分账、提现、资质或法律规则保持功能关闭，不以模拟成功状态上线。

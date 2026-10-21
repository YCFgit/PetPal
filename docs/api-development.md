# 开发 API 使用说明

此处描述实际可运行接口，与完整业务草案分开维护。服务默认 `http://127.0.0.1:3100`；除健康、目录、时段查询外，使用 `.env` 中的 `PETPAL_DEV_TOKEN` 作为 Bearer token。该认证仅供本地开发，未接入微信。

## 现有接口

| 方法 | 路径 | 输入 / 输出 |
| --- | --- | --- |
| GET | `/health` | 公开，明确返回开发模式、内存存储和支付关闭状态 |
| GET | `/api/v1/services` | 公开有效服务目录，包含整数分价格和版本；开发数据并非营业报价 |
| GET | `/api/v1/slots?serviceId=...&areaId=...` | 公开未来时段、剩余名额，按开始时间排序，最多返回前 100 条 |
| GET | `/api/v1/pets` | 本地认证用户的示例宠物，无创建/编辑能力 |
| GET | `/api/v1/addresses` | 本地认证用户的示例地址，不含入户凭证 |
| POST | `/api/v1/orders/quotes` | 请求 `{serviceId, slotId, addressId, petIds}`，返回报价、金额/规则快照、到期时间；不占名额 |
| POST | `/api/v1/orders` | 请求 `{quoteId}`，必须有 `Idempotency-Key`；成功 201；占名额、写订单/事件 |
| GET | `/api/v1/orders?limit=20&cursor=...` | 本人订单，返回 `{items,nextCursor}`；limit 1–100；cursor 是上页末单 ID |
| GET | `/api/v1/orders/{id}` | 本人订单详情；其他用户或未知 ID 同样 404 |
| POST | `/api/v1/orders/{id}/cancel-requests` | 请求 `{}` 和 `Idempotency-Key`；只允许从未提交支付渠道的待支付订单 |

当前完整报价对象和订单快照只向所属用户返回。生产接口字段和权限需在正式微信认证后再次评审。目录、时段、示例宠物/地址清单只适配有限开发数据，不具备完整生产分页能力。

## 通用格式

成功：`{data, requestId}`。失败：`{code, message, requestId}`。服务端生成并返回 `X-Request-Id`，错误不泄露内部堆栈。时间为 UTC ISO 8601，金额为整数分，响应 `Cache-Control: no-store`。

POST 必须使用 `Content-Type: application/json`，不支持压缩请求，最大请求体 16 KiB，未知字段被拒绝。幂等键使用 8–128 位字母、数字、连字符或下划线；相同用户/操作/键对不同请求体返回 409。相同键重放创建/取消返回同一订单 ID 和当前订单状态，不承诺历史响应字节不变。

| HTTP | 典型错误码 |
| --- | --- |
| 400 | `INVALID_REQUEST`, `INVALID_JSON` |
| 401 | `UNAUTHORIZED` |
| 404 | `NOT_FOUND` |
| 409 | `SLOT_FULL`, `SLOT_UNAVAILABLE`, `QUOTE_EXPIRED`, `QUOTE_CONSUMED`, `QUOTE_STALE`, `IDEMPOTENCY_CONFLICT`, `PAYMENT_VERIFICATION_REQUIRED` |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| 501 | `PAYMENTS_NOT_IMPLEMENTED`（已认证的预支付/回调占位请求；不代表真实接入） |

## 本地请求示例

先在 `.env` 显式启用 `PETPAL_ENABLE_DEMO_DATA=true` 并配置随机 token，启动 API。以下 token 环境变量应在本地终端设置，不提交到源码。

```sh
curl http://127.0.0.1:3100/health
curl http://127.0.0.1:3100/api/v1/services
curl 'http://127.0.0.1:3100/api/v1/slots?serviceId=demo-cat-care&areaId=demo-area'
curl -H "Authorization: Bearer $PETPAL_DEV_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"serviceId":"demo-cat-care","slotId":"demo-slot","addressId":"demo-address","petIds":["demo-cat"]}' \
  http://127.0.0.1:3100/api/v1/orders/quotes
```

从报价响应取得 `data.id`，用 `{ "quoteId": "取得的ID" }` 调用 `POST /api/v1/orders`，并添加 `Idempotency-Key: local-order-001`。同一报价只能创建一个订单。服务不会提供支付成功按钮或修改支付事实的测试后门。

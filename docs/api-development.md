# 开发 API 使用说明

此处描述实际可运行接口，与完整业务草案分开维护。服务默认 `http://127.0.0.1:3100`；除健康、目录、时段查询外，使用 `.env` 中的 `PETPAL_DEV_TOKEN` 作为 Bearer token。该认证仅供本地开发，未接入微信。

## 现有接口

| 方法 | 路径 | 输入 / 输出 |
| --- | --- | --- |
| GET | `/health` | 公开，明确返回开发模式、当前存储类型和支付关闭状态 |
| GET | `/api/v1/services` | 公开有效服务目录，包含整数分价格和版本；开发数据并非营业报价 |
| GET | `/api/v1/slots?serviceId=...&areaId=...` | 公开未来时段、剩余名额，按开始时间排序，最多返回前 100 条 |
| GET / POST | `/api/v1/pets` | 本人宠物列表 / 创建；创建输入 `{name,type,careNotes?}`，type 为 `CAT` 或 `DOG`，成功 201 |
| GET / PATCH / DELETE | `/api/v1/pets/{petId}` | 本人详情 / 部分更新 / 删除；其他用户或未知 ID 均 404 |
| GET / POST | `/api/v1/addresses` | 本人基础地址列表 / 创建；输入 `{areaId,label}`，成功 201，不含入户凭证 |
| GET / PATCH / DELETE | `/api/v1/addresses/{addressId}` | 本人详情 / 部分更新 / 删除；areaId 须对应已配置的有效服务及时段 |
| POST | `/api/v1/orders/quotes` | 请求 `{serviceId, slotId, addressId, petIds}`，返回报价、金额/规则快照、到期时间；不占名额 |
| POST | `/api/v1/orders` | 请求 `{quoteId}`，必须有 `Idempotency-Key`；成功 201；占名额、写订单/事件 |
| GET | `/api/v1/orders?limit=20&cursor=...` | 本人订单，返回 `{items,nextCursor}`；limit 1–100；cursor 是上页末单 ID |
| GET | `/api/v1/orders/{id}` | 本人订单详情；其他用户或未知 ID 同样 404 |
| POST | `/api/v1/orders/{id}/cancel-requests` | 请求 `{}` 和 `Idempotency-Key`；只允许从未提交支付渠道的待支付订单 |

当前完整报价对象和订单快照只向所属用户返回。生产接口字段和权限需在正式微信认证后再次评审。目录、时段、示例宠物/地址清单只适配有限开发数据，不具备完整生产分页能力。

## 资料维护规则

- 资源 `id` 和 `userId` 由服务端生成/绑定，禁止请求体自行指定；`x-user-id` 不改变身份。
- 宠物 `name` 去除首尾空白后长度 1–80，`careNotes` 默认空字符串、最多 2000 字符，可用空字符串清空。类型仅 `CAT`/`DOG`；不接收诊疗等额外字段。
- 地址仅支持 `areaId` 和 `label`（去除首尾空白后长度 1–200），尚不是完整精确地址模型，不接收联系人、电话或入户密码。区域限制仅查已有有效服务/时段配置，不代表地理位置核验。
- PATCH 至少一个可修改字段，遗漏字段保持不变；`null`、未知字段、非法控制字符和过长文本返回 400。
- DELETE 成功返回 200 和 `{data:{id,deleted:true},requestId}`；不存在或已删除返回 404。待支付订单引用资料时返回 409 `RESOURCE_IN_USE`，取消/超时释放后可删除。
- 与报价快照不一致的宠物或地址资料不能直接使用旧报价建单，返回 `QUOTE_STALE`；被删除的地址返回 404，被删除的宠物返回 `QUOTE_STALE`。需刷新资料并重新报价。
- 更新/删除资料不修改已创建订单快照，不是订单改址或个人信息彻底删除流程。
- 创建资料暂不支持幂等键；网络结果未知时先查询列表核对，不应直接重复创建。MySQL 模式可跨进程重启保留资料，内存模式会在重启后清空。

## MySQL 开发模式

在 `.env` 中显式设置 `PETPAL_STORAGE=mysql`、`MYSQL_DATABASE=petpal_dev`、`MYSQL_USER`、`MYSQL_PASSWORD`。本机安装常用 `MYSQL_SOCKET=/tmp/mysql.sock`；未设置 socket 时使用 `MYSQL_HOST=127.0.0.1` 和 `MYSQL_PORT=3306`。

首次使用前，MySQL 管理员执行 `mysql -u root -p < apps/api/src/scripts/mysql-local-setup.sql`，为 `ycf` 只创建并授权 `petpal_dev`、`petpal_test` 两个库；之后应用账号可执行 `npm run db:migrate` 和 `npm run dev`，不需要全局建库权限。`npm run test:mysql` 会删除测试库内的记录以隔离用例，因此测试库名被强制要求以 `petpal_test` 开头，禁止指向开发库或生产库。

### 备份与恢复

- `npm run db:backup` 使用 `mysqldump --single-transaction` 导出当前 `MYSQL_DATABASE`，默认写入 `~/.petpal/backups/`；也可用 `npm run db:backup -- /absolute/path/backup.sql` 指定路径。备份旁会生成 SHA-256 文件，SQL 文件权限为仅当前用户可读写。
- 备份含数据库中的全部资料和订单快照，仍应视为敏感文件并另行加密存放；校验和只能检测损坏，不能防止恶意篡改或替代异地备份。
- 恢复仅允许目标为 `MYSQL_DATABASE=petpal_dev`，需显式运行 `npm run db:restore -- /absolute/path/backup.sql --confirm=petpal_dev`。恢复会覆盖同名表；运行前先停止 API。脚本先校验备份及其 SHA-256，再自动生成当前库的安全备份，并打印备份位置后执行恢复。
- 如 `mysqldump`/`mysql` 不在 `PATH`，可在 `.env` 设置 `MYSQLDUMP_BIN`/`MYSQL_BIN` 为可执行文件路径。恢复中断可能留下部分恢复状态；保留并使用脚本打印的安全备份恢复，之后重新运行迁移并检查 API。

## 通用格式

成功：`{data, requestId}`。失败：`{code, message, requestId}`。服务端生成并返回 `X-Request-Id`，错误不泄露内部堆栈。时间为 UTC ISO 8601，金额为整数分，响应 `Cache-Control: no-store`。

POST/PATCH 必须使用 `Content-Type: application/json`，不支持压缩请求，最大请求体 16 KiB，未知字段被拒绝。订单创建/取消的幂等键使用 8–128 位字母、数字、连字符或下划线；相同用户/操作/键对不同请求体返回 409。相同键重放创建/取消返回同一订单 ID 和当前订单状态，不承诺历史响应字节不变。

| HTTP | 典型错误码 |
| --- | --- |
| 400 | `INVALID_REQUEST`, `INVALID_JSON` |
| 401 | `UNAUTHORIZED` |
| 404 | `NOT_FOUND` |
| 409 | `SLOT_FULL`, `SLOT_UNAVAILABLE`, `QUOTE_EXPIRED`, `QUOTE_CONSUMED`, `QUOTE_STALE`, `IDEMPOTENCY_CONFLICT`, `PAYMENT_VERIFICATION_REQUIRED`, `AREA_UNAVAILABLE`, `RESOURCE_IN_USE` |
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

也可先创建虚构资料，再使用返回的 ID 报价：

```sh
curl -H "Authorization: Bearer $PETPAL_DEV_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"测试猫咪","type":"CAT","careNotes":"仅供开发测试"}' \
  http://127.0.0.1:3100/api/v1/pets
curl -H "Authorization: Bearer $PETPAL_DEV_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"areaId":"demo-area","label":"虚构测试地址"}' \
  http://127.0.0.1:3100/api/v1/addresses
```

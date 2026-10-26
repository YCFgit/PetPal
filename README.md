# PetPal · 宠伴上门

当前交付：开发用后端——宠物档案/基础地址资料维护、服务目录、服务端报价、预约容量占用、幂等建单、本人订单查询和安全取消；不代表完整 MVP 已完成。

文档入口：[实施规格](docs/implementation/README.md)、[开发 API](docs/api-development.md)、[交付状态与缺口](docs/development-status.md)、[原始方案](docs/reference/implementation-plan-v2.md)。

## 当前架构与边界

- TypeScript 业务核心 + Node.js HTTP 开发适配器；本轮依赖安装使用本机缓存及单独获取的依赖包，尚未引入原方案建议的 NestJS。未来接入 NestJS 应复用业务核心，不重写金额、归属和容量规则。
- 已提供开发用内存存储和本地 MySQL 8 事务存储。MySQL 使用行级锁、唯一约束、迁移版本校验和连接池，并提供本地备份/显式确认恢复命令；生产级异地加密备份和容量压测仍未完成。
- 仅有显式启用的本地 Bearer token 认证；不接受客户端自行指定用户身份，未实现微信登录。开发认证和内存存储在生产模式直接拒绝启动。
- 不接入、不模拟成功支付或真实实名认证；所有订单保持待支付。未来一旦创建渠道支付单，必须先查单/关单，不能复用当前“从未进入支付渠道”的取消路径释放容量。
- 示例价格、区域和时段仅用于本地演示，需显式启用示例数据，不能视为已确认的经营配置。
- 资料维护使用服务端分配的用户身份和资源 ID；地址暂只有 `areaId`、`label`，不收集电话、精确住址或入户凭证。资料与报价快照不一致时要求重新报价；待支付订单引用的资料不可删除，已创建订单保留原快照。

## 本地运行

要求 Node.js 22.18+ 和 npm；本轮使用 Node.js 24.14.1 验证。

```sh
npm ci
cp .env.example .env
```

在 `.env` 中设置至少 32 字符的随机 `PETPAL_DEV_TOKEN`；如需演示服务和时段，设置 `PETPAL_ENABLE_DEMO_DATA=true`。不要提交 `.env` 或将开发 token 放进前端正式构建。

使用本地 MySQL 时设置 `PETPAL_STORAGE=mysql`、`MYSQL_DATABASE=petpal_dev`、用户名和密码；可设置 `MYSQL_SOCKET=/tmp/mysql.sock`，否则使用 `MYSQL_HOST`/`MYSQL_PORT`。首次启动前执行：

```sh
mysql -u root -p < apps/api/src/scripts/mysql-local-setup.sql
npm run db:migrate
npm run test:mysql
```

首次 SQL 需要本机 MySQL 管理员执行；应用账号不需要全局建库权限。`db:migrate` 只创建缺失表、不清空已有数据；集成测试只清理 `petpal_test` 库内的表数据，不会删除数据库。不要把测试库配置为开发库。

MySQL 可用 `npm run db:backup` 备份至 `~/.petpal/backups/`，用 `npm run db:restore -- <backup.sql> --confirm=petpal_dev` 恢复。恢复前停止 API；脚本会先校验 SHA-256 并自动备份当前开发库。详见 [API 与数据库操作](docs/api-development.md)。

```sh
npm run check
npm run build
npm start
```

服务默认仅监听 `127.0.0.1:3100`。`npm run dev` 可直接运行 TypeScript 源文件。

当前 `npm run check` 通过类型检查、构建和 48 项领域/进程内接口测试；用户终端的 MySQL 8 迁移、2 项数据库集成测试及 HTTP 健康/报价/建单/幂等重放/取消/重启后查询冒烟均已通过。备份校验逻辑有单测，本机实际备份/恢复演练尚待执行。沙箱本身仍不能访问本机数据库 socket。

## 后续实施顺序

1. 评审业务范围、时段规则、取消政策和端形态。
2. 对已接入的 MySQL 事务存储完成备份恢复演练、容量压测和生产配置管理。
3. 接入微信登录；在已有开发用资料维护基础上完善精确地址模型、隐私授权及生产权限。
4. 接入真实支付：验签、查单、关单、退款及对账补偿。
5. 人工派单、履约、私有影像、入户授权、售后与结算。
6. 开发用户/喂养师小程序及 PC 管理后台，完成灰度准入。

首个提交已同步至 GitHub。本轮改动保留在本地工作区；当前环境 Git 网络通道受限，需要推送时可在系统终端执行 `git push`。

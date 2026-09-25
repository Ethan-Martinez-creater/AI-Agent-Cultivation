# ADR 0003：使用 SQLite 而非本机 PostgreSQL

状态：已采纳（Gate 0）

本机虽然已安装 PostgreSQL，V1 Windows Alpha 的目标是单用户、本地优先、可直接打包运行。SQLite 随应用内嵌，无需安装或维护数据库服务，更符合计划的明确技术选型。使用 `better-sqlite3`、显式 SQL 迁移、WAL 和外键。数据位置由 `userData` 决定。

代价是 native module 必须针对 Electron ABI 重建，并在 Windows 打包后的进程中验证。团队/远程多用户同步超出 V1 范围；若产品边界改变，再评估 PostgreSQL。

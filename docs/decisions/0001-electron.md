# ADR 0001：Electron 作为 Windows 桌面运行时

状态：已采纳（Gate 0）

采用 Electron Forge + Vite + TypeScript + React。Main 持有本地数据库和将来的 Provider/MCP 连接，Renderer 只通过窄口 IPC。强制 sandbox、context isolation 和关闭 Node integration；Main 拦截导航、窗口打开与权限请求。

代价是应用体积和内存高于轻量桌面方案，且需要验证 native module 重建。因此 Gate 0 必须实际运行 Windows 打包产物并打开 SQLite。

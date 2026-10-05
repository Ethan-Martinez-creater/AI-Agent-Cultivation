# G2 H3 Integration evidence

本目录记录真实 Windows packaged app 对 production H3 HTTP Adapter 的离线验收。HTTP server 是 test-only deterministic fixture；MP4 是已验证的合成媒体，不是实际 GPU 模型输出。正常 production bootstrap 不加载 FakeGenerationGateway。

## 验收链

- Renderer 创建生成对话、输入 prompt、导入首帧图片并明确选择 role。
- typed IPC → sealed GENERATION Runtime → health/models → streaming files upload → videos submit。
- 原 G1 GenerationTask/Job → 原 providerJobId 查询 → streaming binary → verified Main cache → G1 Artifact Store。
- APP_ARTIFACT_STORE 登记成功后，Main-issued opaque media token 恢复可播放视频；Renderer 不获得 Provider URL、Credential 或绝对存储路径。
- 原进程中断后恢复同 Job；partial download 可以重新下载原 output；完整缓存与已登记 Artifact 不重复下载/注册。
- UNKNOWN 重启零 submit/poll/download；offline 明确 UNAVAILABLE，无消息/Job/改派。

成功验收 run 的 `facts.json` 保存 HTTP counters、durable Job/Artifact/Chat/Binding/Availability 事实及截图清单。1440/900 截图来自实际 BrowserWindow 尺寸，并实际调用 HTMLMediaElement.play 验证可解码。

## 归档索引

- [独立 packaged facts](4fa8ca3a-248e-4442-9506-da1738c9e091/facts.json)：14 张 1440/900 截图；两个已登记 MP4 均达到 `readyState=4`；首帧上传、下载中断后原 Job 恢复、UNKNOWN 零重提、offline 不改派。
- [完整 smoke 尾部 facts](305e09ad-4ac2-4df8-8ecd-03706cfe5dc0/facts.json)：2026-10-06 完整 `npm run smoke:package` exit 0；同样的 14 张截图与持久化验收链，完整命令日志为 `validation/smoke-package.txt`。
- `validation/`：最终 test、typecheck、lint、format、Windows x64 package 与全量 packaged smoke 命令输出；测试 113 files / 935 tests。
- `validation/forge-windows-glob-preload.cjs.txt`：本机 Forge Windows glob 路径兼容 shim 原文，仅用于构建，不进入 product bootstrap。

视频画面为 deterministic FFmpeg 合成测试片段；真正验收的是实际 HTTP/streaming/Artifact/播放/重启状态链。真实 H3 Endpoint 联调仍未执行。

## 协议边界

媒体 scheme 使用 Electron 的 standard/secure/stream/corsEnabled 能力；仍遵守原 CSP，仅接受 trusted Renderer origin、Main-issued token、GET/HEAD 与合法 Range。没有关闭 webSecurity 或启用 bypassCSP。参见 [Electron protocol API](https://www.electronjs.org/docs/latest/api/protocol)。

## Live integration

BLOCKED / NOT RUN：部署侧尚未提供真实 H3 Endpoint/访问配置。离线 HTTP fixture 验收不等价于真实 GPU 联调。

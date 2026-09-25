# ADR 0002：道友身份与模型运行配置分离

状态：已采纳（Gate 0）

`Teammate` 不包含 `modelId`、`providerId` 或 API Key。它只通过 `currentRuntimeProfileId` 引用 `RuntimeProfile`；后者指向 Provider、Credential 和 Model。未来切换运行配置时，道友 ID、记忆归属、技能、Mission 历史和经历保留。

这增加一次运行时解析，但使长期道友成为真正稳定的领域实体。

# 安全说明

## 支持范围

当前版本优先支持 macOS + Codex Desktop。其它平台暂不承诺可用。

## 数据处理

本工具只读取和写入本机 Codex 状态文件：

- `~/.codex/state_5.sqlite`
- `~/.codex/.codex-global-state.json`
- `~/.codex/session_index.jsonl`
- 会话 rollout JSONL 文件

工具不会上传数据，不会请求外部服务。Electron 版也只打开本地 `127.0.0.1` 页面。

## 写入安全

- “预览”不会修改文件。
- “执行恢复”前会创建备份。
- 默认会先退出 Codex，避免 Codex 运行中的内存状态覆盖修复结果。

## 报告安全问题

如果你发现本工具存在安全问题，请不要在公开 issue 中贴出个人 Codex 数据或会话内容。

建议开一个 GitHub issue，描述问题类型、复现步骤和影响范围；涉及隐私内容时请先脱敏。

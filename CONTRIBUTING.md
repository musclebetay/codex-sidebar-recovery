# 贡献指南

感谢你愿意改进 Codex 侧边栏恢复工具。

## 本地开发

```bash
npm ci
npm run check
npm start
```

开发双击版：

```bash
npm run app:dev
npm run app:pack
```

## 提交前检查

请至少运行：

```bash
npm run check
npm pack --dry-run
```

如果改动影响 Electron 打包，请额外运行：

```bash
npm run app:dist
```

## 设计原则

- 中文用户优先，界面文案默认使用中文。
- 默认安全：预览只读，执行前必须备份。
- 不上传任何本地 Codex 数据。
- 尽量使用 Node 内置模块和原生前端，避免不必要的依赖。
- 不要提交个人 `~/.codex` 数据、恢复备份、构建产物或一次性本机修复脚本。

## Pull Request 建议

请在 PR 中说明：

- 改了什么
- 为什么需要这个改动
- 如何验证
- 是否影响恢复写入逻辑

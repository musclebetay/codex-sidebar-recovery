# 发布检查清单

## 首次发布到 GitHub

```bash
git init
git add .gitignore LICENSE README.md CONTRIBUTING.md SECURITY.md package.json package-lock.json bin src public electron docs .github
git commit -m "Initial release"
```

用 GitHub CLI 创建公开仓库：

```bash
gh repo create codex-sidebar-recovery --public --source=. --remote=origin --push
```

如果不用 GitHub CLI，就先在 GitHub 网页创建仓库，然后：

```bash
git remote add origin git@github.com:musclebetay/codex-sidebar-recovery.git
git branch -M main
git push -u origin main
```

## 打 tag 发布 GitHub Release

```bash
npm run check
npm pack --dry-run
npm run app:dist

git tag v0.1.0
git push origin v0.1.0
```

推送 tag 后，GitHub Actions 会自动构建 macOS zip 并上传到 Release。

## 手动上传本机构建产物

如果不使用 GitHub Actions，可以手动上传：

```text
release/Codex 侧边栏恢复工具-0.1.0-arm64.zip
```

## 发布 npm 包

```bash
npm login
npm publish --access public
```

发布后用户可以运行：

```bash
npx codex-sidebar-recovery
```

## 注意

- 不要提交 `node_modules/`。
- 不要提交 `release/`。
- 不要提交个人一次性恢复脚本。
- 第一版 macOS App 未签名，Release 说明里要提醒用户首次打开可能需要右键打开。

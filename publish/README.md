# 发布流程（本地记录）

## 1. 发 npm（需要 npmjs 凭据）

```bash
npm login --registry=https://registry.npmjs.org/     # 或提供 npm token
npm publish --registry=https://registry.npmjs.org/   # publishConfig 已写死 npmjs
npm view dsh-cronops version dsh dist.tarball
```

打包产物核对：`npm pack --dry-run` → 18 个文件（index.js、client.js、lib/**、cordis.patch.yml、
locale/*.json、icon.svg、README.md、LICENSE、package.json），`scripts/` 与 `publish/` 不进包。

## 2. GitHub Release（可选，给不发 npm 的用户）

```bash
npm pack --pack-destination /tmp      # 生成 /tmp/dsh-cronops-0.1.0.tgz
git tag v0.1.0 && git push origin v0.1.0
# 网页创建 Release 并上传 tgz，或给 PAT 用 API
```

然后把 `publish/awesome-entry.yml` 里的 `tarball:` 取消注释。

## 3. 提 PR 到 awesome-dsh-plugin

1. fork `awesome-dsh-plugin/awesome-dsh-plugin`；
2. 新分支加 `data/plugins/fjcqv__dsh-cronops.yml`（内容见本目录 `awesome-entry.yml`）；
3. PR 正文用 `publish/pr-body.md`；
4. **仓库需创建满 1 天**（2026-11-17 23:14 建，11-18 23:14 后才满足），并给仓库加 `dsh-plugin` topic。

## 4. 收录后

- 等 CI 重新生成 README，检查 `https://awesome-dsh-plugin.com/plugins.json` 出现 `dsh-cronops`；
- 用发布产物做一次安装验证（`install_bundle` 指向 npm 包或 tgz），确认三个面板与页签正常。

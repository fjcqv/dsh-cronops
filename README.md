# dsh-cronops · 青龙 / 呆呆面板控制台

[![npm](https://img.shields.io/npm/v/dsh-cronops.svg)](https://www.npmjs.com/package/dsh-cronops)
[![license](https://img.shields.io/npm/l/dsh-cronops.svg)](LICENSE)

在 DSH 侧边栏管理自托管的**定时任务面板**：用面板自己的 OpenAPI 应用凭据连接，页面里管连接、环境变量与定时任务，其余资源交给 agent 工具。目前支持两款面板：

| 面板 | 版本 | 接口 | 凭据 |
|---|---|---|---|
| 青龙面板 Qinglong | 2.x（实测 2.24.0） | `/open/*` + Bearer（30 天） | `client_id` / `client_secret` |
| 呆呆面板 Daidai | 3.x（实测 3.4.4） | `/api/v1/*` + Bearer（24 小时） | `app_key` / `app_secret` |

面板的凭据只换令牌、不落浏览器；权限用**只读探测**得出并落库，页面加载不再反复查询。插件是纯 JavaScript、无构建步骤、宿主半只依赖 `node:*`。

## Features

- **三个页签**：主机（面板连接）、环境变量、定时任务——与「定时面板」这个产品形态一一对应。
- **双驱动**：青龙与呆呆各一套驱动，字段与状态词归一后 UI 只认一套（任务状态、环境变量的分组/重要等）。
- **权限探测落库**：点「测试」才探测，结果写进面板记录（版本、凭据状态、每个 scope 的有/无/超时）；主机表按中文展示，切换面板不发请求。
- **四个 agent 工具**：`cronops_panels` / `cronops_envs` / `cronops_crons` / `cronops_api`，与页面共用同一实现，页面能做的 agent 也能做。
- **本机回环栅栏**：`/api/dsh-cronops/*` 只接受本机回环直连（socket + Host + 同源标记），反向代理需显式开启。
- **不打扰的反馈**：成功只在「运行任务」时提示一次（2.5 秒自动消失），失败常驻；任务页 5 秒静默轮询状态。

## Install

**npm（推荐）**

```bash
dsh plugin --profile web add dsh-cronops
```

随后在「插件管理 → Bundles」里启用 `dsh-cronops`，**刷新一次 Web 页面**（浏览器半随模块清单加载）。

**从本地目录**

```bash
git clone git@github.com:fjcqv/dsh-cronops.git
# 插件管理器：{ action: "install_bundle", target: "/abs/path/to/dsh-cronops" }
```

## Quick start

1. 面板侧建一个应用：
   - 青龙：系统设置 → 应用设置 → 新建，勾 `envs`、`crons`（其余按需），复制 `client_id` / `client_secret`。
   - 呆呆：Open API 页面 → 新建，勾 `tasks`、`envs`（其余按需），记下 `app_key` / `app_secret`（只显示一次）。
2. 页面「主机 → 新增面板」：选类型、填地址（如 `http://10.0.0.2:5700`）与凭据；也可以把类型切成「令牌」直接粘一个现有 token。
3. 点「测试」——按钮会禁用并显示「测试中…」，完成后表格直接是落库后的权限与版本。
4. 切到「环境变量」「定时任务」开始管理；页头下拉切换面板，两个页签会立刻重拉。

## Usage

**主机**：`别名 | 类型 | 面板地址 | 权限 | 状态 | 操作`。不显示凭据（只在编辑对话框里），地址列定宽省略、悬停看全文；行内只有 测试 / 编辑 / 设为默认 / 删除。新增后自动选中，删除当前面板会回落到默认面板。

**权限与状态**：权限来自只读探测（青龙 9 项、呆呆 7 项），中文名展示，状态为 `有权限 ✓ / 无权限 ✗ / 超时 ⏱ / 探测失败 ?`；改 `类型 / 地址 / 凭据 / 超时` 会清空旧结果。

**定时任务**：运行 / 停止 / 启用 / 禁用 / 删除 / 看日志 / 新建 / 编辑；页面每 5 秒静默轮询一次（隐藏时停），动作在途时该行按钮禁用并淡化；日志抽屉默认每 3 秒自动刷新，可关闭。

**环境变量**：搜索、批量启停、新建/编辑/删除；值直接展示（等宽、可换行、可选中），呆呆的「分组 / 重要」单独标出。敏感值由面板服务端遮蔽，界面显示的就是面板给的值。

## Tools

| 工具 | 能力 |
|---|---|
| `cronops_panels` | `list` 列面板 / `test` 探活并落库（连通性、版本、凭据、scope） |
| `cronops_envs` | `list` / `create` / `update` / `delete` / `enable` / `disable` |
| `cronops_crons` | `list` / `get` / `create` / `update` / `run` / `stop` / `enable` / `disable` / `delete` / `log` / `preview` |
| `cronops_api` | 通用桥：青龙 `/open/*`、呆呆 `/api/v1/*` |

`cronops_api` 只放行业务资源：青龙 `/open/apps|auth|user|update`、呆呆 `open-api|users|auth|mcp` 一律拒绝（凭据、账号、备份、面板更新不交给模型）。路径走错时会附加「常用路径」提示。

## Configuration

插件没有单独的设置页；需要改默认行为就在 profile 的 `cordis.patch.yml` 里给这一行加 config：

```yaml
- id: cronops
  name: dsh-cronops
  config:
    enabled: true              # 总开关：路由 + 工具 + 提示段
    announceToAgent: false     # 向 agent 注入能力说明
    requestTimeoutMs: 15000    # 单次请求面板的超时（1000–120000）
    allowProxiedRequests: false # 允许经反代转发到本机的请求
```

## Security & data

- 面板连接存 `$DSH_HOME/dsh-cronops.json`（默认 `~/.dsh`），权限 `0600`、tmp+rename 原子写；损坏时旁置 `.corrupt-<时间戳>`。
- `appSecret` / token 明文只在这个用户私有文件里，**永不返回给浏览器或 agent**（接口只投影 `appKey`、`hasSecret`）。
- `/api/dsh-cronops/*` 走本机回环栅栏；写操作真实修改面板，运行任务只代表面板受理触发，不代表脚本执行完成。

## Compatibility

- 青龙 2.x（实测 2.24.0）：`/open` OpenAPI，应用令牌 30 天。
- 呆呆 3.x（实测 3.4.4）：`/api/v1` OpenAPI，应用令牌 24 小时。
- Node >= 24.9、dsh >= 0.2.2-rc.1；浏览器半需要 Web GUI（Desktop 亦可）。

**已知限制**

- 呆呆的**通知渠道**不参与权限探测：`GET /api/v1/notifications` 只认面板用户令牌 + 管理员，应用凭据必然 403。
- 呆呆没有 `GET /tasks/:id`，任务详情由列表扫描得出；批量运行每批最多 10 个（插件自动分批）。
- 青龙 `GET /open/dependencies` 全量扫描要 10–16 秒，依赖探测改走 `?type=python3` 快路径（<1 秒），失败才回退无参请求。

## Development

```bash
node scripts/selftest.mjs        # 主机半：两套 mock 面板 + 全部路由/错误分支（93 项）
node scripts/check-tools.mjs     # 工具输出契约，用宿主自带校验器（66 项）
node scripts/mock-qinglong.mjs 5799   # 假青龙：mock-client / mock-secret
node scripts/mock-daidai.mjs 5798     # 假呆呆：dd-key / dd-secret
```

`scripts/` 只用于验证，不参与运行时。发布由 GitHub Actions 的 **Trusted Publishing（OIDC）** 完成，不需要 npm token 或 2FA：

```bash
# 改 package.json 版本后
git commit -am "release: vX.Y.Z" && git push
git tag vX.Y.Z && git push origin vX.Y.Z     # tag 推送即触发发布（带 provenance）
```

首次使用前需在 npmjs 包页 Settings → Trusted Publisher 里授权 `fjcqv/dsh-cronops` 的 `publish.yml`（Environment 留空）。

## License

[Apache-2.0](LICENSE)

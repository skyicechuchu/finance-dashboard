# 金融小助手（自托管版）

[English](README.md) | **简体中文**

![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?logo=sqlite&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-Era%20Context-6E56CF)
![Claude](https://img.shields.io/badge/Claude-API-D97757?logo=anthropic&logoColor=white)
![Tailscale](https://img.shields.io/badge/Access-Tailscale-242424?logo=tailscale&logoColor=white)
![Personal use](https://img.shields.io/badge/use-personal%20%2F%20private-lightgrey)

极简的个人理财 dashboard：每笔消费和分类、每周/每月统计和 AI 理财建议、卡片福利、新卡机会。覆盖信用卡以及支票和储蓄账户。

数据来自 [Era Context](https://era.app)，存在你自己服务器上的 SQLite 里，只有你能访问。

## 功能

- **消费**：每笔交易的金额和分类。改分类时可以选只改这一笔，或者同一商家的全部交易一起改。
- **报告**：每周（周一开始）和每月按分类汇总，由 Claude 生成理财建议。点某个分类可以看到它包含的交易。
- **卡片福利**：每张卡的返现倍数，以及按月、季、年发放的福利，可以勾选记录用了哪些。
- **新卡机会**：当前的开卡奖励，和你已有的卡对比。
- **账户**：支票和储蓄账户余额、收入和还卡款。

## 工作方式

- **Era Context**：服务器作为 MCP 客户端连接 `https://context.era.app/mcp`，用 OAuth 登录，不需要 API key。第一次打开页面时点「登录」，用 Era 账户授权一次，之后服务器自动续期。
- **同步**：服务器每 `SYNC_HOURS` 小时从 Era 拉一次最近 14 天的交易存进 SQLite，页面打开时只读本地数据，不消耗 Era 调用次数。页面上的「刷新」最多 30 分钟触发一次同步。Organize 套餐每月 1000 次 MCP 调用，每次同步约 3 次，默认 6 小时一次大约每月 360 次。新关联的账户会在下一次同步时拉全部历史。
- **分类、福利勾选、建议**：存在 SQLite（`data/dashboard.db`）。
- **理财建议**：填了 `ANTHROPIC_API_KEY` 才会出现「生成建议」按钮。
- `web/index.html` 和 claude.ai 上的版本是同一个文件，`web/selfhost-shim.js` 把页面的数据接口接到本服务器。

## 部署

需要 Docker 和 Docker Compose。

```bash
git clone https://github.com/skyicechuchu/finance-dashboard.git
cd finance-dashboard
cp .env.example .env      # 编辑 PUBLIC_URL，可选填 ANTHROPIC_API_KEY
docker compose up -d --build
```

然后在浏览器打开 `PUBLIC_URL`，点登录链接完成 Era 授权。第一次会把 `HISTORY_START` 以来的交易全部同步一遍。

更新：

```bash
git pull && docker compose up -d --build
```

### 配置（`.env`）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | 你在浏览器里打开 dashboard 的地址，必须完全一致，Era 登录完成后会跳回这里。 |
| `PORT` | `8080` | 服务器监听的端口。 |
| `ANTHROPIC_API_KEY` | 空 | 填了才会在报告页生成 AI 建议。 |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | 生成建议用的模型。 |
| `SYNC_HOURS` | `6` | 多久从 Era 同步一次（小时）。 |
| `HISTORY_START` | `2026-04-01` | 第一次同步从哪天开始拉历史。 |
| `ERA_SCOPES` | 空 | 可选，向 Era 申请的权限（空格分隔）。留空则用 Era 默认的权限范围。 |

改了 `PUBLIC_URL` 会重新注册 OAuth 客户端，需要再登录一次 Era。

## 访问方式：推荐 Tailscale

`docker-compose.yml` 只把端口绑定在 `127.0.0.1:8080`，不对公网开放。用 Tailscale 在手机和电脑上访问：

```bash
# 服务器上安装 Tailscale 并运行 `sudo tailscale up` 登录后
sudo tailscale serve --bg 8080
```

`tailscale serve status` 会显示形如 `https://你的机器名.你的tailnet.ts.net` 的地址。把它填进 `.env` 的 `PUBLIC_URL`，再 `docker compose up -d` 重启。手机装 Tailscale 并登录同一个账户，就能打开这个地址。

不用 Tailscale 的话，可以用 Cloudflare Tunnel 加 Cloudflare Access（邮箱验证）。不建议只靠密码直接暴露在公网。

## 数据备份

所有状态都在 `data/dashboard.db`，备份这个文件即可。删除它等于退出 Era 登录并清空本地数据。

## 本地开发

```bash
npm install
npm start      # Node 22.13+，默认 http://localhost:8080
```

`npm start` 会读取 `.env`（如果有），默认只监听 `127.0.0.1`，除非设置了 `HOST`。

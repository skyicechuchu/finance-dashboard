# 金融小助手（自托管版）

个人信用卡 dashboard：每笔消费和分类、每周/每月统计和理财建议、卡片福利、新卡机会。
数据来自 Era Context（Chase、U.S. Bank、BofA），存在你自己服务器上的 SQLite 里，只有你能访问。

## 工作方式

- **Era Context**：通过 MCP（`https://context.era.app/mcp`）加 OAuth 登录读取数据，不需要 API key。第一次打开页面时点「登录」，用 Era 账户授权一次，之后服务器自动续期。
- **同步**：服务器每 `SYNC_HOURS` 小时从 Era 拉一次最近 14 天的交易存进 SQLite，页面打开时只读本地数据，不消耗 Era 调用次数。页面上的「刷新」最多 30 分钟触发一次同步。Organize 套餐每月 1000 次 MCP 调用，每次同步约 3 次，默认 6 小时一次大约每月 360 次。
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

然后在浏览器打开 `PUBLIC_URL`，点「点这里登录」完成 Era 授权。第一次会把 2026-04-01 以来的交易全部同步一遍。

更新：

```bash
git pull && docker compose up -d --build
```

## 访问方式：推荐 Tailscale

`docker-compose.yml` 只把端口绑定在 `127.0.0.1:8080`，不对公网开放。用 Tailscale 在手机和电脑上访问：

```bash
# 服务器上安装并登录 Tailscale 后
sudo tailscale serve --bg 8080
```

`tailscale serve status` 会显示形如 `https://你的机器名.xxx.ts.net` 的地址。把它填进 `.env` 的 `PUBLIC_URL`，再 `docker compose up -d` 重启。手机装 Tailscale 并登录同一个账户就能打开。

不用 Tailscale 的话，可以用 Cloudflare Tunnel 加 Cloudflare Access（邮箱验证）。不建议只靠密码直接暴露在公网。

## 数据备份

所有状态都在 `data/dashboard.db`，备份这个文件即可。删除它等于退出 Era 登录并清空本地数据。

## 本地开发

```bash
npm install
npm start      # Node 22.13+，默认 http://localhost:8080
```

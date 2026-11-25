# Oh My Sage（Web 版 · BeeconMini AC1 部署与更新指南）

本项目为小米米家中枢网关 AI 助手的 Web 端，支持在页面内直接配置**中枢网关地址**与 **AI 模型参数**，配置持久化保存在服务端（`.sessionstore/settings.json`），无需在启动前预设 `.env`，任意设备浏览器打开均可直接复用。

---

## 一、环境说明

- **目标设备**：BeeconMini AC1（ARM64 / OpenWrt / iStoreOS / BMoS）
- **基础镜像**：`m.daocloud.io/docker.io/library/node:22-alpine`
- **服务端口**：`3000`
- **持久化目录**：
  - `/opt/oh-my-sage`：解压后的运行程序（挂载到容器 `/app`）
  - `/opt/oh-my-sage-data`：服务端配置与对话历史（挂载到容器 `/app/.sessionstore`）

---

## 二、本机打包（Windows PowerShell）

在项目根目录依次执行构建与打包，生成 `oh-my-sage-web.tar.gz`：

```powershell
# 1. 清理旧构建并执行 Next.js standalone 构建
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
npm run build

# 2. 组装独立运行包并压缩为 oh-my-sage-web.tar.gz
node -e "const fs=require('fs'),path=require('path');const b='.deploy-bundle';fs.rmSync(b,{recursive:true,force:true});fs.cpSync('.next/standalone',b,{recursive:true,dereference:true});fs.cpSync('.next/static',path.join(b,'.next/static'),{recursive:true});if(fs.existsSync('public'))fs.cpSync('public',path.join(b,'public'),{recursive:true});if(fs.existsSync('.agents'))fs.cpSync('.agents',path.join(b,'.agents'),{recursive:true});for(const p of ['.env','.sessionstore','.git','node_modules/bufferutil']){fs.rmSync(path.join(b,p),{recursive:true,force:true});}"
tar -czf oh-my-sage-web.tar.gz -C .deploy-bundle .
Remove-Item -Recurse -Force .deploy-bundle
```

> 打包完成后确认 `oh-my-sage-web.tar.gz` 已生成在项目根目录。

---

## 三、首次在 AC1 部署容器

1. **拉取镜像**：在 AC1 后台 **Docker → 镜像** 中拉取 `m.daocloud.io/docker.io/library/node:22-alpine`。
2. **上传压缩包**：在 AC1 后台 **系统 → 文件传输** 上传 `oh-my-sage-web.tar.gz`（会保存到 `/tmp/upload/oh-my-sage-web.tar.gz`）。
3. **创建容器**：在 **Docker → 容器 → 添加** 中按以下参数创建：
   - **容器名称**：`oh-my-sage-web`
   - **镜像**：`m.daocloud.io/docker.io/library/node:22-alpine`
   - **重启策略**：`Unless stopped`（除非手动停止）
   - **端口映射**：`3000:3000`（TCP）
   - **挂载卷（Bind Mount）**：
     - `/tmp/upload:/tmp/upload`
     - `/opt/oh-my-sage:/app`
     - `/opt/oh-my-sage-data:/app/.sessionstore`
   - **环境变量**：
     - `HOSTNAME=0.0.0.0`
     - `PORT=3000`
     - `NODE_ENV=production`
   - **运行命令**（适配 LuCI 表单，启动时自动检测压缩包并解压更新）：
     ```text
     node -e if(require("fs").existsSync("/tmp/upload/oh-my-sage-web.tar.gz"))require("child_process").execSync("rm\x20-rf\x20/app/*\x20/app/.next\x20/app/.agents&&tar\x20-xzf\x20/tmp/upload/oh-my-sage-web.tar.gz\x20-C\x20/app&&rm\x20-f\x20/tmp/upload/oh-my-sage-web.tar.gz");process.chdir("/app");import("/app/server.js")
     ```

启动后在容器日志中看到 `✓ Ready in ...` 即表示部署成功。

---

## 四、后续更新步骤

容器已内置自动覆盖更新逻辑，后续修改代码后**无需删除或重建容器**，只需 3 步：

1. **本机重新打包**：按第二节命令生成新的 `oh-my-sage-web.tar.gz`。
2. **上传新包**：在 AC1 **系统 → 文件传输** 上传新的 `oh-my-sage-web.tar.gz`。
3. **重启容器**：在 AC1 **Docker → 容器** 中点击 `oh-my-sage-web` 的 **重启**。

容器启动时会自动清理旧程序、解压新包并删除临时压缩包；`/opt/oh-my-sage-data` 中的网关配置、AI 模型配置和聊天记录会完整保留。

---

## 五、访问与配置

### 1. 访问地址
- **局域网直连**：`http://<AC1 局域网 IP>:3000`
- **外网穿透（DDNSTO）**：
  - 在 DDNSTO 控制台新建一条外网域名映射（不能直接给 LuCI 域名加 `:3000`）。
  - 协议选 `http://`，内网地址填 `127.0.0.1:3000`（若 DDNSTO 客户端不在同一台设备，则填 `<AC1 局域网 IP>:3000`）。
  - 生效后直接访问新生成的 `https://<自定义前缀>.gd.ddnsto.com/`（无需加 `:3000`）。

### 2. 页面内配置网关与 AI
1. 打开网页后点击右上角 **「服务配置」**（登录后也可在左下角 **「设置 → 模型与网关配置」** 修改）。
2. **中枢网关地址**：直接填写米家中枢网关（极客版）的**局域网 IP**（例如 `http://<网关 IP>`），**不要填内网穿透地址**（连接网关的是局域网内的 AC1 容器，内网直连最稳定）。
3. **AI 模型配置**：填写 OpenAI 兼容接口的 `API Base URL`、`API Key` 与模型名称。
4. 保存后输入 6 位动态登录码连接网关即可使用，换其他电脑或浏览器打开均无需重复配置。

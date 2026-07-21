# 自动写作（后台本地任务）

自动连写跑在本机 `server.mjs` 进程里，**不是**跑在浏览器标签里。关掉网页 ≠ 停任务；关掉 Node 服务才会停。

## 前提

1. 保持服务在跑：`npm start`（默认端口 `4568`，可用环境变量 `NOVEL_PORT`）
2. 已在「设置 → 模型服务」配好 API Key
3. 在「设置 → 自动写作配置」设好停止条件（写到第几章、跑几小时、额度不足是否停）

## 启停命令

在项目根目录：

```bash
npm start                 # 启动服务（关网页也要留着这个进程）
npm run auto:start        # 对「最近修改的一本书」开始自动连写
npm run auto:status       # 查看进度
npm run auto:stop         # 停止当前自动任务
npm run auto:watch        # 看门狗巡检（卡住/异常时尝试自愈）
```

指定某一本（目录名 = `data/books/` 下的文件夹名）：

```bash
node auto-ctl.mjs start "开局奶妈,boss血怎么又满了"
node auto-ctl.mjs stop  "开局奶妈,boss血怎么又满了"
node auto-ctl.mjs status "开局奶妈,boss血怎么又满了"
```

网页里：打开作品 →「自动写到完本」/「停止自动写作」，效果与上面命令相同。

## 停止条件（设置中心）

| 项 | 含义 |
|---|---|
| 写到第 N 章停止 | `0` = 用该书建书时填的目标章数 |
| 运行满 N 小时停止 | `0` = 不限时 |
| Token/余额不足停止 | API 返回额度类错误时结束任务，避免空转 |
| 配额错误停止 | 预扣费失败、quota 等一并视为致命错误 |

章数、每章字数只在**建书**时设定，不在这里改。

## 防休眠

笔记本一休眠，Node 进程会被挂起，任务等于停住。

### Windows

管理员 PowerShell：

```powershell
# 开启：插入电源时不睡眠、不休眠（显示器仍可关）
powershell -File scripts/keep-awake-win.ps1

# 恢复系统默认电源策略
powershell -File scripts/keep-awake-win.ps1 -Off
```

也可：设置 → 系统 → 电源 → 屏幕和睡眠 → 插电时设为「从不」。

### macOS

```bash
bash scripts/keep-awake-mac.sh
```

运行期间用 `caffeinate` 阻止休眠；`Ctrl+C` 结束脚本即恢复。

## 注意

- 只关浏览器可以；**不要关**跑 `npm start` 的终端（除非你用 `Start-Process`/服务方式托管）。
- 电脑重启后需重新 `npm start`，再 `npm run auto:start`。
- 看门狗 `auto:watch` 适合挂计划任务/cron，不是必须。

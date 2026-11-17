# KK AppState Viewer

Windows 专用：用 `appstate.dat` + 运行时根钥 `R`（或已有 DEK）批量解包房间密钥，解密本地 `chatLogs_*.edb` 并浏览聊天记录。

所有处理在本机完成，不上传数据。

## 与 KakaoChat Viewer 的关系

| | KakaoChat Viewer | 本应用 |
|--|------------------|--------|
| 取钥 | 每房内存扫 DEK / 旧派生 | appstate 一次解全量 DEK |
| 平台 | Mac + Win | **以 Windows 为主** |
| 输入 | 设备材料 / memscan | `R` 或 keys JSON |

## 使用

```bash
cd "kk-appstate-viewer"
npm install
npm start
```

### 全自动流程（默认）

与产品约定一致：**一次拿到运行时根钥 R → 从 appstate 解包全部 DEK → 解密浏览**。

1. 发现账号（取 appstate 最大的）
2. 解析 `appstate.dat`
3. 仅检查本工具自己保存的 `kk-root-key.json`（**不读 kk-collect / win-key-cache**）
4. 若无 R 且 KakaoTalk **正在运行** → 内存搜索 R
5. 用 R 解包全部 DEK（失败则整流程失败，不会退回历史 DEK）
6. 解密本地 EDB 并进入聊天浏览

注意：

- **搜 R 需要 KakaoTalk 登录运行**；**解密文件建议退出 KakaoTalk**（否则可能全零/被锁）
- 若解密因占用失败，页面会出「我已退出，继续」（沿用本次已解出的 DEK，仍不是 kk-collect 缓存）
- 任何失败都会显示在页面顶部红色错误条

手动模式仅作兜底（粘贴 / 导入本工具的 `kk-root-key.json`）。

## 开发自检

```bash
npm run test:crypto
```

## 目录

- `electron/` 主进程：发现账号、appstate 解包、SQLCipher 页解密
- `js/` 渲染进程：统一库打开与聊天 UI（复用 viewer 的 `kakaoDb` / `messageParser`）
- `vendor/` SQLCipher WASM

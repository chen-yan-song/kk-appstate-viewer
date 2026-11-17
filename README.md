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

启动后自动执行：

1. 发现账号（取 appstate 最大的）
2. 解析 `appstate.dat`
3. 在桌面 / 缓存 / ProgramData 等位置查找 `kk-root-key.json`、`win-key-cache.json`
4. 若没有 R 且 KakaoTalk **正在运行** → 内存搜索根钥 R（可能数分钟）
5. 用 R 解包全部 DEK
6. 解密本地 EDB 并进入聊天浏览

注意：

- **搜 R 需要 KakaoTalk 登录运行**；**解密文件建议退出 KakaoTalk**（否则可能全零/被锁）
- 若解密因占用失败，页面会出「我已退出 KakaoTalk，继续」按钮，点一次即可续跑（不必重搜 R）
- 任何失败都会显示在页面顶部红色错误条

手动模式仅作兜底（导入 JSON / 粘贴 R）。

## 开发自检

```bash
npm run test:crypto
```

## 目录

- `electron/` 主进程：发现账号、appstate 解包、SQLCipher 页解密
- `js/` 渲染进程：统一库打开与聊天 UI（复用 viewer 的 `kakaoDb` / `messageParser`）
- `vendor/` SQLCipher WASM

# SuperWiki Staging Area

<!-- 任务进行中未完成、待验证或临时记录的知识点暂存区。格式：
## [YYYY-MM-DD HH:MM] <简述>
<具体内容>
-->

## [2026-10-08 16:10] bundle-mac.ts 的 --zip 写 blockmap 分支尚未在 macOS 上真跑过
增量更新落地（见 wiki-architecture-one-core-two-shells 9.3/9.4/9.5）中，`computeBlockMapSync` + `serializeBlockMap` 在 `main()` 的 `if (CREATE_ZIP)` 分支里写 `<zip>.blockmap`，该分支依赖 macOS 专用工具链（plutil/codesign/ditto/hdiutil），在本机（Linux）无法执行。已证明的替代证据：`computeBlockMapSync`/`serializeBlockMap`/`parseBlockMap`/`assembleFromBlockMap` 共 20 个单测通过；`tsx` 解析 `'../src/blockmap.js'` 探针打印 `function`；一个独立 e2e 脚本对 3MB 假 zip 完成 blockmap→Range 拼装并比对 sha256 一致。待有 macOS 环境时跑一次 `pnpm app:zip` 确认产物中出现 `SuperIU-<version>-mac-<arch>.zip.blockmap`，确认后删除本条。

## [2026-10-08 16:10] install.sh / 桌面 remote bootstrap 仍走全量下载（刻意的非目标）
增量只接入了两条自更新通道：桌面 updater（blockmap）与 `superiu-server update` / 空闲自动更新（delta patch）。`scripts/install.sh`（用 curl 拉 `${base}/${asset}`）与 `packages/desktop/src/remote/bootstrap.ts`（在远端主机 curl 拉二进制）仍是全量下载——在 shell 里实现补丁应用需要重写 delta 应用器，且 `$HOME/.superiu/bin/superiu-server` 与远端主机上的既有二进制未必是补丁记录的源。若日后要覆盖这两条路径，应让它们改调已安装二进制自己的 `update`（`acquireBinary`）而不是在 shell 里重实现。

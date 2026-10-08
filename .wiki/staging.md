# SuperWiki Staging Area

<!-- 任务进行中未完成、待验证或临时记录的知识点暂存区。格式：
## [YYYY-MM-DD HH:MM] <简述>
<具体内容>
-->

## [2026-10-08 16:45] bundle-mac.ts 的 --zip 写 blockmap 分支已在真实发布中验证通过（v0.2.21）
`main()` 的 `if (CREATE_ZIP)` 分支只能在 macOS 上执行，此前无法本地冒烟。v0.2.21 的 tag 发布中 `build desktop (macOS)` 作业实跑了该路径，发布资产经核对无误：`SuperIU-0.2.21-mac-arm64.zip.blockmap`（139231 字节）为 `version=1` / `chunkSize=65536` / `filesize=135994831`（等于发布的 zip 字节数）/ `blocks` 2076 条（等于 `ceil(filesize/chunkSize)`），且其 `sha256` 与 `SuperIU-0.2.21-mac-arm64.zip.sha256` 完全一致。同一次发布也验证了服务端补丁链路：`superiu-server-linux-{arm64,x64}.patch` 的 78 字节明文头可解析，`targetSha256` 等于对应发布二进制的 sha256；arm64 补丁 94241 字节，源 `865c353c…`（= v0.2.20 与滚动 `latest` 的 arm64 二进制，两者字节相同）→ 目标 `3fbb07d3…`（= v0.2.21）。本条无待办。

## [2026-10-08 16:10] install.sh / 桌面 remote bootstrap 仍走全量下载（刻意的非目标）
增量只接入了两条自更新通道：桌面 updater（blockmap）与 `superiu-server update` / 空闲自动更新（delta patch）。`scripts/install.sh`（用 curl 拉 `${base}/${asset}`）与 `packages/desktop/src/remote/bootstrap.ts`（在远端主机 curl 拉二进制）仍是全量下载——在 shell 里实现补丁应用需要重写 delta 应用器，且 `$HOME/.superiu/bin/superiu-server` 与远端主机上的既有二进制未必是补丁记录的源。若日后要覆盖这两条路径，应让它们改调已安装二进制自己的 `update`（`acquireBinary`）而不是在 shell 里重实现。

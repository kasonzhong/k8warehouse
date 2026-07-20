# K8 退货处理系统 V12（腾讯文档API入口＋手机作电脑摄像头）


V11修复V10中两个实际问题：

1. Excel中图片显示为 `#BLOCKED!`
2. 腾讯文档无法稳定接收网页/Excel复制过去的图片

## 为什么V10会出现 #BLOCKED!

V10使用了 Excel 的 `IMAGE()` 网络图片公式，图片来源是Supabase签名链接。

这种方式理论上是真正的“单元格图片”，但在很多Excel环境中会被安全策略当作外部链接数据拦截，因此显示：

```text
#BLOCKED!
```

所以V11取消默认使用 `IMAGE()` 公式。

## V11的Excel方案

现在导出的Excel改回“真实嵌入图片文件”：

- 图片数据直接写入 `.xlsx` 文件内部
- 打开文件不需要联网加载图片
- 不会显示 `#BLOCKED!`
- 图片被锚定在对应单元格区域内
- 图片会尽量随单元格移动和缩放
- 图片可以在Excel中点击、拖动、复制

注意：Excel真正意义上的“图片属于单元格内容”目前只有 `IMAGE()` 公式路线，但该路线会遇到安全拦截和兼容性问题。V11选择稳定优先。

## 腾讯文档方案

不再推荐从Excel或网页直接复制图片到腾讯文档。

原因：

- 腾讯文档对图片剪贴板兼容不稳定
- 不同浏览器表现不同
- Excel里的图片对象复制到腾讯文档经常丢失
- HTML富文本复制也不稳定

V11新增：

```text
导出腾讯文档上传版
```

使用方法：

1. 点击退货单卡片上的“导出腾讯文档上传版”
2. 下载 `.xlsx`
3. 打开腾讯文档
4. 选择“导入 / 上传本地表格”
5. 上传这个 `.xlsx`

这是现阶段不接腾讯开放平台API时最稳定的路线。

## 如果未来要做到最稳定

需要申请腾讯文档开放平台应用，通过后端调用API：

- 创建在线表格
- 写入SKU、日期、单号
- 上传图片
- 插入单元格图片
- 设置共享权限

这需要OAuth、后端服务和腾讯开放平台审核，不适合继续用纯前端PWA直接完成。

## 更新方式

使用补丁包时，不会覆盖你的 `supabase-config.js`。

GitHub Desktop Summary建议填写：

```text
Fix Excel images and Tencent Docs export
```

部署后建议用无痕窗口测试。


## V12新增

### 1. 腾讯文档 Open API 同步入口

退货单卡片新增“同步到腾讯文档API”。

该按钮会请求 Vercel 后端：

```text
POST /api/tencent/sync
```

当前已放入安全后端入口，但腾讯文档开放平台应用、OAuth、access_token刷新、创建表格、上传图片、InsertImages插入单元格图片逻辑需要在申请应用后补齐。

配置说明见：

```text
TENCENT_DOCS_API_SETUP.md
```

### 2. 手机作为电脑摄像头

电脑端进入退货任务后点击：

```text
手机作摄像头
```

系统会生成手机连接。手机打开链接并登录同一账户后，电脑可以点击按钮让手机拍照，照片会上传到当前退货任务。

说明见：

```text
PHONE_CAMERA_SETUP.md
```

## GitHub更新

补丁包不包含 `supabase-config.js`，不会覆盖现有Supabase配置。

Summary建议：

```text
Add Tencent API bridge and remote phone camera
```

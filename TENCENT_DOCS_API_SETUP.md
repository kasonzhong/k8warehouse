# V12 腾讯文档 Open API 对接说明

## 为什么不能继续用 Excel/复制粘贴

腾讯文档中的“单元格图片”不是普通 HTML 图片，也不是 Excel 浮动图片。稳定方案是通过腾讯文档 Open API 上传图片，获得 imageID，然后用 InsertImages 接口按行列插入为单元格图片。

## 需要准备

1. 腾讯文档开放平台应用
2. AppID / AppSecret
3. OAuth 回调地址
4. 后端服务保存 refresh_token / access_token
5. Vercel Serverless Function 调用腾讯 API

## Vercel 环境变量

在 Vercel Project Settings -> Environment Variables 添加：

```text
TENCENT_DOCS_APP_ID=你的AppID
TENCENT_DOCS_APP_SECRET=你的AppSecret
TENCENT_DOCS_ACCESS_TOKEN=测试用access_token
```

正式版不建议长期使用固定 access_token，应实现 OAuth 登录和 token 自动刷新。

## API逻辑

网站点击“同步到腾讯文档API”后，会请求：

```text
POST /api/tencent/sync
```

后端应做：

1. 验证当前用户权限
2. 创建或打开腾讯文档表格
3. 写入 sku、日期、单号
4. 遍历退货照片
5. 上传图片到腾讯文档获得 imageID
6. 调用 InsertImages，类型选择单元格图片
7. 返回腾讯文档链接

当前 V12 已经放入后端入口和前端按钮，但腾讯开放平台授权和具体业务参数需要你申请应用后再补齐。

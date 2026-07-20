// V12 Tencent Docs API bridge (Vercel Serverless Function)
// This file is a backend placeholder: it proves the website can call a secure backend.
// To make it fully functional, configure Tencent Docs Open Platform OAuth and implement:
// 1. Exchange/refresh access_token
// 2. Create or locate the target spreadsheet
// 3. Write text values: sku/date/tracking
// 4. Upload each image and get imageID
// 5. Call InsertImages with image type = 1 (cell image)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed', message: 'Use POST' });
  }

  const required = [
    'TENCENT_DOCS_APP_ID',
    'TENCENT_DOCS_APP_SECRET',
    'TENCENT_DOCS_ACCESS_TOKEN'
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    return res.status(501).json({
      error: 'tencent_not_configured',
      message: `腾讯文档 Open API 后端尚未配置：缺少 ${missing.join(', ')}`,
      next: '申请腾讯文档开放平台应用，在 Vercel Project Settings -> Environment Variables 配置变量，然后实现 OAuth token 刷新。'
    });
  }

  // Intentionally not making unauthenticated Tencent writes here.
  // Add your OAuth token validation and Tencent API calls before enabling production writes.
  return res.status(501).json({
    error: 'implementation_required',
    message: '后端环境变量已存在，但腾讯文档创建表格、上传图片、插入单元格图片逻辑仍需按你的开放平台应用参数完成。'
  });
}

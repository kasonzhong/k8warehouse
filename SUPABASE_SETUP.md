# K8 V8：Supabase 云端账户配置

## 1. 创建 Supabase 项目

进入 Supabase Dashboard，创建一个新项目。

记录数据库密码，但不要把数据库密码放进 GitHub。

## 2. 建立数据库和照片权限

在 Supabase 项目中打开：

```text
SQL Editor → New query
```

复制项目文件中的：

```text
supabase-setup.sql
```

粘贴并点击 Run。

这一步会创建：

- `profiles`：用户资料
- `return_batches`：每个账户自己的退货数据
- `return-photos`：私有照片存储桶
- Row Level Security 策略
- Realtime 同步

## 3. 设置网站地址

打开：

```text
Authentication → URL Configuration
```

填写：

```text
Site URL:
https://你的Vercel域名
```

例如：

```text
https://k8warehouse.vercel.app
```

在 Redirect URLs 中也加入：

```text
https://k8warehouse.vercel.app/**
```

本地测试时可以额外加入：

```text
http://localhost:8080/**
```

## 4. 获取项目地址和浏览器密钥

在 Supabase 项目中打开 Connect 或 API 设置，复制：

- Project URL
- Publishable Key

旧项目可能显示为 anon public key，也可以使用。

**绝对不要使用 Service Role Key。**

## 5. 编辑配置文件

打开：

```text
supabase-config.js
```

替换：

```javascript
window.K8_SUPABASE_CONFIG = {
  url: 'https://你的项目ID.supabase.co',
  publishableKey: '你的Publishable Key',
  photoBucket: 'return-photos'
};
```

保存。

## 6. 上传到 GitHub

在 GitHub Desktop 中会看到文件变化。

填写 Summary：

```text
Add Supabase accounts and cloud sync
```

然后：

```text
Commit to main
Push origin
```

Vercel会自动部署。

## 7. 测试账户隔离

建议使用两个不同邮箱：

1. A账户创建一张退货单并拍照。
2. 退出登录。
3. 注册B账户。
4. B账户不应看到A账户的数据。
5. 再登录A账户，电脑和手机应看到同一数据。

## 8. 邮箱确认

Supabase默认可能要求注册用户确认邮箱。

注册后如果没有直接进入系统，请打开确认邮件。

测试阶段也可以在Supabase Auth设置中关闭邮箱确认，但正式使用建议保留。

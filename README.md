# K8 退货处理系统 V8（云端账户版）

V8在V7基础上加入账户、云端数据库、私有照片存储和电脑/手机同步。

## 新增功能

- 邮箱＋密码注册
- 登录、退出
- 忘记密码和邮件重置
- 每个账户拥有独立退货数据
- 数据保存到 Supabase PostgreSQL
- 照片保存到私有 Supabase Storage
- Row Level Security 阻止用户读取其他账户的数据
- 电脑和手机登录同一账户后共享数据
- Realtime实时接收另一台设备的更新
- 网络恢复后自动同步
- 本机保留一份缓存
- 可将旧版本地退货单和照片迁移到当前云端账户

## 必须完成的配置

V8不能仅上传到Vercel后直接使用。首次使用前必须：

1. 创建Supabase项目
2. 运行 `supabase-setup.sql`
3. 设置Vercel域名为Auth Site URL
4. 编辑 `supabase-config.js`
5. Commit并Push到GitHub

完整步骤见：

```text
SUPABASE_SETUP.md
```

## 安全设计

浏览器使用Publishable Key或anon key。

真正的数据隔离由数据库RLS执行：

- `auth.uid() = user_id`
- 照片路径第一层必须等于当前用户ID
- Storage Bucket为Private

不要把Service Role Key放进网站或GitHub。

## 数据同步方式

退货单数据使用JSON存入`return_batches`表。

照片路径格式：

```text
用户ID/退货单ID/退货任务ID/照片.jpg
```

电脑和手机登录同一账号后读取同一表和同一私有存储桶。

## 当前协作边界

V8支持同一个账户在多个设备同步。

如果未来需要一个公司内：

- 管理员查看全部员工数据
- 员工只看自己处理的任务
- 多员工共同处理同一客户
- 客户只读查看报告

下一版需要增加组织、成员、角色和权限模型。

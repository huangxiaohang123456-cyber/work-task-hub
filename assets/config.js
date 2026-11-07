/* 工作任务台 · 配置
 * 登录隔离版：数据存于 Supabase（每用户隔离），前端用 publishable(等同 anon) 密钥
 * 作为 apikey，再用用户登录后的 JWT 作为 Authorization 读写。
 * 真正的私密密钥是 service_role，请勿填在此处、也不要发给任何人。
 */
window.APP_CONFIG = {
  SUPABASE_URL: 'https://xgmvmlymnqpzpakdwvzy.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_tVaBo51W46wBFd8OyW8aOQ_hm6fCzDc',
  APP_NAME: '工作任务台'
};
